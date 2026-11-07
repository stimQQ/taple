use std::path::Path;

use serde::Serialize;
use specta::Type;
use tracing::*;

use super::task_error;

#[derive(Serialize, Type, Debug, Clone)]
pub struct StoryboardEntry {
    pub segment_index: u32,
    pub time_secs: f64,
    pub change_score: f64,
    pub text: Vec<String>,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_screen_storyboard(
    project_path: String,
    sample_interval_secs: f64,
) -> Result<Vec<StoryboardEntry>, String> {
    let handle = tokio::runtime::Handle::current();

    tokio::task::spawn_blocking(move || {
        build_storyboard(Path::new(&project_path), sample_interval_secs, handle)
    })
    .await
    .map_err(task_error)?
}

#[cfg(not(target_os = "macos"))]
fn build_storyboard(
    _project_path: &Path,
    _sample_interval_secs: f64,
    _handle: tokio::runtime::Handle,
) -> Result<Vec<StoryboardEntry>, String> {
    Err(crate::i18n::tr(
        "当前系统不支持屏幕分析",
        "Screen analysis is not supported on this platform",
    )
    .to_string())
}

#[cfg(target_os = "macos")]
use mac::build_storyboard;

#[cfg(target_os = "macos")]
pub(crate) mod mac {
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        sync::mpsc,
    };

    use cap_project::StudioRecordingMeta;
    use cap_video_decode::AVAssetReaderDecoder;
    use cidre::{arc, cv, ns, objc, vn};
    use ffmpeg::format::Pixel;
    use tracing::*;

    use super::StoryboardEntry;
    use crate::ai::{display_source, load_meta};
    use crate::i18n::tr;

    const DEFAULT_SAMPLE_INTERVAL_SECS: f64 = 1.0;
    const MIN_SAMPLE_INTERVAL_SECS: f64 = 0.25;
    const MAX_SAMPLES: usize = 900;
    const FORWARD_DECODE_LIMIT_SECS: f64 = 0.5;
    const TIME_EPSILON_SECS: f64 = 0.001;
    const THUMB_WIDTH: usize = 96;
    const THUMB_HEIGHT: usize = 60;
    const THUMB_TAPS: usize = 4;
    const PIXEL_CHANGE_THRESHOLD: u8 = 24;
    const OCR_CHANGE_THRESHOLD: f64 = 0.02;
    const SETTLED_CHANGE_THRESHOLD: f64 = 0.005;
    const MAX_UNSETTLED_SAMPLES: usize = 3;
    const MAX_OCR_FRAMES: usize = 150;
    const MAX_TEXT_LINES: usize = 40;
    const MAX_LINE_CHARS: usize = 160;
    const MIN_LINE_CHARS: usize = 2;
    const MIN_TEXT_CONFIDENCE: f32 = 0.3;

    pub(crate) struct SegmentSource {
        pub(crate) index: u32,
        pub(crate) path: PathBuf,
        pub(crate) offset: f64,
        pub(crate) duration: f64,
    }

    pub(crate) struct DecodedImage {
        pub(crate) pts: f64,
        pub(crate) image: arc::R<cv::ImageBuf>,
    }

    struct SendImage(arc::R<cv::ImageBuf>);

    unsafe impl Send for SendImage {}

    struct OcrJob {
        entry: usize,
        image: SendImage,
    }

    #[derive(Clone)]
    struct TextLine {
        text: String,
        height: f64,
    }

    struct Sample {
        entry: usize,
        image: arc::R<cv::ImageBuf>,
        thumbnail: Vec<u8>,
    }

    pub(crate) struct FrameReader {
        decoder: AVAssetReaderDecoder,
        current: Option<DecodedImage>,
        pending: Option<DecodedImage>,
        exhausted: bool,
    }

    impl FrameReader {
        pub(crate) fn new(path: PathBuf, handle: tokio::runtime::Handle) -> Result<Self, String> {
            Ok(Self {
                decoder: AVAssetReaderDecoder::new(path, handle)?,
                current: None,
                pending: None,
                exhausted: false,
            })
        }

        fn next_frame(&mut self) -> Option<DecodedImage> {
            if self.exhausted {
                return None;
            }

            for sample in self.decoder.frames() {
                let Ok(sample) = sample else {
                    continue;
                };
                let Some(image) = sample.image_buf() else {
                    continue;
                };

                return Some(DecodedImage {
                    pts: sample.pts().as_secs(),
                    image: image.retained(),
                });
            }

            self.exhausted = true;
            None
        }

        fn seek(&mut self, time: f64) -> Result<(), String> {
            self.decoder.reset(time as f32)?;
            self.exhausted = false;
            self.pending = None;
            self.current = self.next_frame();
            Ok(())
        }

        pub(crate) fn frame_at(&mut self, time: f64) -> Result<Option<&mut DecodedImage>, String> {
            let needs_seek = match (&self.current, &self.pending) {
                (None, None) => true,
                (Some(current), _) if time + TIME_EPSILON_SECS < current.pts => true,
                (_, Some(pending)) if pending.pts > time + TIME_EPSILON_SECS => false,
                (Some(current), None) => time - current.pts > FORWARD_DECODE_LIMIT_SECS,
                (_, Some(pending)) => time - pending.pts > FORWARD_DECODE_LIMIT_SECS,
            };

            if needs_seek {
                self.seek(time)?;
            } else {
                loop {
                    if let Some(pending) = self.pending.take() {
                        if pending.pts <= time + TIME_EPSILON_SECS {
                            self.current = Some(pending);
                        } else {
                            self.pending = Some(pending);
                            break;
                        }
                    }

                    match self.next_frame() {
                        Some(frame) => self.pending = Some(frame),
                        None => break,
                    }
                }
            }

            Ok(match self.current.as_mut() {
                Some(current) => Some(current),
                None => self.pending.as_mut(),
            })
        }
    }

    fn probe_display_video(path: &Path) -> Result<(Option<f64>, Pixel), String> {
        let input = ffmpeg::format::input(path).map_err(|e| {
            format!(
                "{}: {e}",
                tr("打开屏幕视频失败", "Failed to open screen video")
            )
        })?;

        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or_else(|| {
                tr("屏幕视频中没有画面", "The screen video has no video track").to_string()
            })?;

        let decoder = ffmpeg::codec::Context::from_parameters(stream.parameters())
            .and_then(|context| context.decoder().video())
            .map_err(|e| {
                format!(
                    "{}: {e}",
                    tr("读取屏幕视频失败", "Failed to read screen video")
                )
            })?;

        let duration = input.duration();
        let duration =
            (duration > 0).then(|| duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE));

        Ok((duration, decoder.format()))
    }

    pub(crate) fn segment_sources(project_path: &Path) -> Result<Vec<SegmentSource>, String> {
        let meta = load_meta(project_path)?;
        let segment_count = match meta.studio_meta() {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len(),
        };

        let mut sources = Vec::with_capacity(segment_count);
        for index in 0..segment_count as u32 {
            let source = display_source(&meta, index)?;

            if !source.path.exists() {
                return Err(format!(
                    "{}: {}",
                    tr("找不到屏幕视频文件", "Screen video file not found"),
                    source.path.display()
                ));
            }

            let (duration, format) = probe_display_video(&source.path)?;
            if !matches!(format, Pixel::NV12 | Pixel::YUV420P) {
                return Err(format!(
                    "{}: {format:?}",
                    tr("不支持的视频像素格式", "Unsupported video pixel format")
                ));
            }

            sources.push(SegmentSource {
                index,
                path: source.path,
                offset: source.offset,
                duration: duration
                    .map(|duration| (duration - source.offset).max(0.0))
                    .unwrap_or(0.0),
            });
        }

        Ok(sources)
    }

    pub(crate) fn luma_thumbnail(image: &mut arc::R<cv::ImageBuf>) -> Option<Vec<u8>> {
        if image.plane_count() == 0 {
            return None;
        }

        unsafe {
            image
                .lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY)
                .result()
                .ok()?;
        }

        let width = image.plane_width(0);
        let height = image.plane_height(0);
        let stride = image.plane_bytes_per_row(0);
        let base = image.plane_base_address(0);

        let thumbnail = (!base.is_null() && width > 0 && height > 0).then(|| {
            let data = unsafe { std::slice::from_raw_parts(base, stride * height) };
            let sample_columns = THUMB_WIDTH * THUMB_TAPS;
            let sample_rows = THUMB_HEIGHT * THUMB_TAPS;

            let mut thumbnail = vec![0u8; THUMB_WIDTH * THUMB_HEIGHT];
            for (cell, value) in thumbnail.iter_mut().enumerate() {
                let cell_x = cell % THUMB_WIDTH;
                let cell_y = cell / THUMB_WIDTH;
                let mut sum = 0u32;

                for tap_y in 0..THUMB_TAPS {
                    let y = ((cell_y * THUMB_TAPS + tap_y) * 2 + 1) * height / (sample_rows * 2);
                    let row = &data[y * stride..y * stride + width];

                    for tap_x in 0..THUMB_TAPS {
                        let x =
                            ((cell_x * THUMB_TAPS + tap_x) * 2 + 1) * width / (sample_columns * 2);
                        sum += u32::from(row[x]);
                    }
                }

                *value = (sum / (THUMB_TAPS * THUMB_TAPS) as u32) as u8;
            }

            thumbnail
        });

        unsafe {
            image.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::READ_ONLY);
        }

        thumbnail
    }

    pub(crate) fn changed_cells(previous: &[u8], current: &[u8], threshold: u8) -> usize {
        previous
            .iter()
            .zip(current)
            .filter(|(a, b)| a.abs_diff(**b) > threshold)
            .count()
    }

    fn change_score(previous: &[u8], current: &[u8]) -> f64 {
        changed_cells(previous, current, PIXEL_CHANGE_THRESHOLD) as f64
            / current.len().max(1) as f64
    }

    fn round_to(value: f64, decimals: i32) -> f64 {
        let factor = 10f64.powi(decimals);
        (value * factor).round() / factor
    }

    fn recognize_text(image: &cv::ImageBuf) -> Vec<TextLine> {
        objc::ar_pool(|| {
            let mut request = vn::RecognizeTextRequest::new();
            request.set_recognition_level(vn::RequestTextRecognitionLevel::Accurate);
            request.set_uses_lang_correction(true);
            let languages = ns::Array::from_slice_retained(&[
                ns::String::with_str("zh-Hans"),
                ns::String::with_str("en-US"),
            ]);
            request.set_recognition_langs(&languages);

            let Some(handler) = vn::ImageRequestHandler::with_cv_pixel_buf(image, None) else {
                return Vec::new();
            };

            let base_request: &vn::Request = &request;
            let requests = ns::Array::from_slice(&[base_request]);
            if let Err(e) = handler.perform(&requests) {
                warn!("Text recognition failed: {e:?}");
                return Vec::new();
            }

            let Some(observations) = request.results() else {
                return Vec::new();
            };

            let mut lines: Vec<(i64, f64, TextLine)> = Vec::new();
            for observation in observations.iter() {
                let candidates = observation.top_candidates(1);
                let Some(candidate) = candidates.first() else {
                    continue;
                };

                if candidate.confidence() < MIN_TEXT_CONFIDENCE {
                    continue;
                }

                let text = candidate.string().to_string();
                let text = text.trim();
                if text.chars().count() < MIN_LINE_CHARS {
                    continue;
                }

                let bounds = observation.bounding_box();
                let top = 1.0 - (bounds.origin.y + bounds.size.height);
                lines.push((
                    (top * 100.0).round() as i64,
                    bounds.origin.x,
                    TextLine {
                        text: text.chars().take(MAX_LINE_CHARS).collect(),
                        height: bounds.size.height,
                    },
                ));
            }

            lines.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));

            lines.into_iter().map(|(_, _, line)| line).collect()
        })
    }

    struct Sampler<'a> {
        entries: &'a mut Vec<StoryboardEntry>,
        jobs: mpsc::SyncSender<OcrJob>,
        ocr_frames: usize,
    }

    impl Sampler<'_> {
        fn request_ocr(
            &mut self,
            entry: usize,
            image: &arc::R<cv::ImageBuf>,
        ) -> Result<(), String> {
            if self.ocr_frames >= MAX_OCR_FRAMES {
                return Ok(());
            }

            self.ocr_frames += 1;
            self.jobs
                .send(OcrJob {
                    entry,
                    image: SendImage(image.clone()),
                })
                .map_err(|_| tr("文字识别中断", "Text recognition stopped").to_string())
        }

        fn sample_segment(
            &mut self,
            source: &SegmentSource,
            interval: f64,
            handle: &tokio::runtime::Handle,
        ) -> Result<(), String> {
            let mut reader = FrameReader::new(source.path.clone(), handle.clone())?;
            let sample_count = (source.duration / interval).floor() as usize + 1;
            let mut previous: Option<Sample> = None;
            let mut ocr_thumbnail: Option<Vec<u8>> = None;
            let mut unsettled = 0;

            for sample in 0..sample_count {
                let time = sample as f64 * interval;

                objc::ar_pool(|| -> Result<(), String> {
                    let Some(frame) = reader.frame_at(time + source.offset)? else {
                        return Ok(());
                    };

                    let Some(thumbnail) = luma_thumbnail(&mut frame.image) else {
                        return Ok(());
                    };

                    let score = previous.as_ref().map_or(1.0, |previous| {
                        change_score(&previous.thumbnail, &thumbnail)
                    });

                    let entry = self.entries.len();
                    self.entries.push(StoryboardEntry {
                        segment_index: source.index,
                        time_secs: round_to(time, 3),
                        change_score: round_to(score, 4),
                        text: Vec::new(),
                    });

                    let current = Sample {
                        entry,
                        image: frame.image.clone(),
                        thumbnail,
                    };

                    match &ocr_thumbnail {
                        None => {
                            self.request_ocr(current.entry, &current.image)?;
                            ocr_thumbnail = Some(current.thumbnail.clone());
                        }
                        Some(last_ocr)
                            if change_score(last_ocr, &current.thumbnail)
                                >= OCR_CHANGE_THRESHOLD =>
                        {
                            if score < SETTLED_CHANGE_THRESHOLD
                                && let Some(previous) = &previous
                            {
                                self.request_ocr(previous.entry, &previous.image)?;
                                ocr_thumbnail = Some(previous.thumbnail.clone());
                                unsettled = 0;
                            } else if unsettled + 1 >= MAX_UNSETTLED_SAMPLES {
                                self.request_ocr(current.entry, &current.image)?;
                                ocr_thumbnail = Some(current.thumbnail.clone());
                                unsettled = 0;
                            } else {
                                unsettled += 1;
                            }
                        }
                        Some(_) => unsettled = 0,
                    }

                    previous = Some(current);
                    Ok(())
                })?;
            }

            if let (Some(previous), Some(last_ocr)) = (&previous, &ocr_thumbnail)
                && change_score(last_ocr, &previous.thumbnail) >= OCR_CHANGE_THRESHOLD
            {
                self.request_ocr(previous.entry, &previous.image)?;
            }

            Ok(())
        }
    }

    fn normalized_text(text: &str) -> String {
        text.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    }

    fn assign_text(entries: &mut [StoryboardEntry], mut results: Vec<(usize, Vec<TextLine>)>) {
        results.sort_by_key(|(entry, _)| *entry);

        let mut previous_segment = None;
        let mut previous_text = String::new();

        for (entry_index, lines) in results {
            let Some(entry) = entries.get_mut(entry_index) else {
                continue;
            };

            if previous_segment != Some(entry.segment_index) {
                previous_text.clear();
                previous_segment = Some(entry.segment_index);
            }

            let keys: Vec<String> = lines
                .iter()
                .map(|line| normalized_text(&line.text))
                .collect();

            let mut seen = HashSet::new();
            let mut fresh: Vec<(usize, &TextLine)> = lines
                .iter()
                .zip(&keys)
                .enumerate()
                .filter(|(_, (_, key))| {
                    key.chars().count() >= MIN_LINE_CHARS
                        && !previous_text.contains(key.as_str())
                        && seen.insert(key.as_str())
                })
                .map(|(order, (line, _))| (order, line))
                .collect();

            if fresh.len() > MAX_TEXT_LINES {
                fresh.sort_by(|a, b| b.1.height.total_cmp(&a.1.height).then(a.0.cmp(&b.0)));
                fresh.truncate(MAX_TEXT_LINES);
                fresh.sort_by_key(|(order, _)| *order);
            }

            entry.text = fresh
                .into_iter()
                .map(|(_, line)| line.text.clone())
                .collect();
            previous_text = keys.concat();
        }
    }

    pub fn build_storyboard(
        project_path: &Path,
        sample_interval_secs: f64,
        handle: tokio::runtime::Handle,
    ) -> Result<Vec<StoryboardEntry>, String> {
        let sources = segment_sources(project_path)?;
        let total_duration: f64 = sources.iter().map(|source| source.duration).sum();

        let requested = if sample_interval_secs.is_finite() && sample_interval_secs > 0.0 {
            sample_interval_secs
        } else {
            DEFAULT_SAMPLE_INTERVAL_SECS
        };
        let interval = requested
            .max(MIN_SAMPLE_INTERVAL_SECS)
            .max(total_duration / MAX_SAMPLES as f64);

        let mut entries = Vec::new();
        let (job_tx, job_rx) = mpsc::sync_channel::<OcrJob>(2);

        let (sampled, results) = std::thread::scope(|scope| {
            let worker = scope.spawn(move || {
                job_rx
                    .into_iter()
                    .map(|job| (job.entry, recognize_text(&job.image.0)))
                    .collect::<Vec<_>>()
            });

            let mut sampler = Sampler {
                entries: &mut entries,
                jobs: job_tx,
                ocr_frames: 0,
            };

            let sampled = sources
                .iter()
                .try_for_each(|source| sampler.sample_segment(source, interval, &handle));
            drop(sampler);

            (sampled, worker.join().unwrap_or_default())
        });

        sampled?;
        assign_text(&mut entries, results);

        Ok(entries)
    }
}
