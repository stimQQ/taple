use std::{
    cmp::Ordering,
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, mpsc},
};

use cidre::{
    arc::R,
    cv::{self, pixel_buffer::LockFlags},
};
use ffmpeg::{Rational, format, frame};
use tokio::{runtime::Handle as TokioHandle, sync::oneshot};

use crate::DecodedFrame;

use super::frame_converter::{FrameConverter, copy_rgba_plane};
use super::{FRAME_CACHE_BYTES, FRAME_CACHE_SIZE, VideoDecoderMessage, pts_to_frame};

#[derive(Clone)]
struct ProcessedFrame {
    number: u32,
    data: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

#[derive(Clone)]
enum CachedFrame {
    Raw {
        image_buf: R<cv::ImageBuf>,
        number: u32,
    },
    Processed(ProcessedFrame),
}

struct ImageBufProcessor {
    converter: FrameConverter,
    scratch_frame: frame::Video,
    scratch_spec: Option<(format::Pixel, u32, u32)>,
}

impl ImageBufProcessor {
    fn new() -> Self {
        Self {
            converter: FrameConverter::new(),
            scratch_frame: frame::Video::empty(),
            scratch_spec: None,
        }
    }

    fn convert(&mut self, image_buf: &mut R<cv::ImageBuf>) -> Vec<u8> {
        let format =
            cap_video_decode::avassetreader::pixel_format_to_pixel(image_buf.pixel_format());

        if matches!(format, format::Pixel::RGBA) {
            return self.copy_rgba(image_buf);
        }

        let width = image_buf.width() as u32;
        let height = image_buf.height() as u32;
        self.ensure_scratch(format, width, height);

        unsafe {
            image_buf
                .lock_base_addr(LockFlags::READ_ONLY)
                .result()
                .unwrap();
        }

        self.copy_planes(image_buf);

        unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

        self.converter.convert(&mut self.scratch_frame)
    }

    fn ensure_scratch(&mut self, format: format::Pixel, width: u32, height: u32) {
        let needs_new =
            self.scratch_spec
                .is_none_or(|(current_format, current_width, current_height)| {
                    current_format != format || current_width != width || current_height != height
                });

        if needs_new {
            self.scratch_frame = frame::Video::new(format, width, height);
            self.scratch_spec = Some((format, width, height));
        }
    }

    fn copy_rgba(&mut self, image_buf: &mut R<cv::ImageBuf>) -> Vec<u8> {
        unsafe {
            image_buf
                .lock_base_addr(LockFlags::READ_ONLY)
                .result()
                .unwrap();
        }

        let bytes_per_row = image_buf.plane_bytes_per_row(0);
        let width = image_buf.width();
        let height = image_buf.height();

        let slice = unsafe {
            std::slice::from_raw_parts::<'static, _>(
                image_buf.plane_base_address(0),
                bytes_per_row * height,
            )
        };

        let bytes = copy_rgba_plane(slice, bytes_per_row, width, height);

        unsafe { image_buf.unlock_lock_base_addr(LockFlags::READ_ONLY) };

        bytes
    }

    fn copy_planes(&mut self, image_buf: &mut R<cv::ImageBuf>) {
        match self.scratch_frame.format() {
            format::Pixel::NV12 | format::Pixel::YUV420P => {
                let scratch = &mut self.scratch_frame;
                for plane_i in 0..image_buf.plane_count() {
                    let bytes_per_row = image_buf.plane_bytes_per_row(plane_i);
                    let height = image_buf.plane_height(plane_i);

                    let ffmpeg_stride = scratch.stride(plane_i);
                    let row_length = bytes_per_row.min(ffmpeg_stride);

                    let slice = unsafe {
                        std::slice::from_raw_parts::<'static, _>(
                            image_buf.plane_base_address(plane_i),
                            bytes_per_row * height,
                        )
                    };

                    for i in 0..height {
                        scratch.data_mut(plane_i)
                            [i * ffmpeg_stride..(i * ffmpeg_stride + row_length)]
                            .copy_from_slice(
                                &slice[i * bytes_per_row..(i * bytes_per_row + row_length)],
                            );
                    }
                }
            }
            format => todo!("implement {:?}", format),
        }
    }
}

impl CachedFrame {
    fn process(&mut self, processor: &mut ImageBufProcessor) -> ProcessedFrame {
        match self {
            CachedFrame::Raw { image_buf, number } => {
                let frame_buffer = processor.convert(image_buf);
                let data = ProcessedFrame {
                    number: *number,
                    data: Arc::new(frame_buffer),
                    width: image_buf.width() as u32,
                    height: image_buf.height() as u32,
                };

                *self = Self::Processed(data.clone());

                data
            }
            CachedFrame::Processed(data) => data.clone(),
        }
    }

    fn size(&self) -> usize {
        match self {
            CachedFrame::Raw { image_buf, .. } => {
                let planes = image_buf.plane_count();
                if planes == 0 {
                    image_buf.width() * image_buf.height() * 4
                } else {
                    (0..planes)
                        .map(|i| image_buf.plane_bytes_per_row(i) * image_buf.plane_height(i))
                        .sum()
                }
            }
            CachedFrame::Processed(data) => data.data.len(),
        }
    }
}

struct FrameCache {
    frames: BTreeMap<u32, CachedFrame>,
    bytes: usize,
    backward: bool,
}

impl FrameCache {
    fn new() -> Self {
        Self {
            frames: BTreeMap::new(),
            bytes: 0,
            backward: false,
        }
    }

    fn processed(
        &mut self,
        number: u32,
        processor: &mut ImageBufProcessor,
    ) -> Option<ProcessedFrame> {
        let frame = self.frames.get_mut(&number)?;
        let before = frame.size();
        let data = frame.process(processor);
        self.bytes = self.bytes + frame.size() - before;
        Some(data)
    }

    fn latest_at_or_before(
        &mut self,
        number: u32,
        not_before: u32,
        processor: &mut ImageBufProcessor,
    ) -> Option<ProcessedFrame> {
        if not_before > number {
            return None;
        }
        let key = *self.frames.range(not_before..=number).next_back()?.0;
        self.processed(key, processor)
    }

    fn insert(&mut self, number: u32, frame: CachedFrame, near: u32) {
        self.bytes += frame.size();
        if let Some(old) = self.frames.insert(number, frame) {
            self.bytes -= old.size();
        }
        self.trim(near);
    }

    fn trim(&mut self, near: u32) {
        let shown = self.frames.range(..=near).next_back().map(|(&key, _)| key);
        while self.bytes > FRAME_CACHE_BYTES {
            let below = self
                .frames
                .keys()
                .copied()
                .find(|&key| key < near && Some(key) != shown);
            let above = self
                .frames
                .keys()
                .rev()
                .copied()
                .find(|&key| key > near && Some(key) != shown);
            let victim = if self.backward {
                above.or(below)
            } else {
                below.or(above)
            };
            let Some(victim) = victim else {
                break;
            };
            if let Some(old) = self.frames.remove(&victim) {
                self.bytes -= old.size();
            }
        }
    }
}

pub struct AVAssetReaderDecoder {
    inner: cap_video_decode::AVAssetReaderDecoder,
    is_done: bool,
}

impl AVAssetReaderDecoder {
    fn new(path: PathBuf, tokio_handle: TokioHandle) -> Result<Self, String> {
        Ok(Self {
            inner: cap_video_decode::AVAssetReaderDecoder::new(path, tokio_handle)?,
            is_done: false,
        })
    }

    fn reset(&mut self, requested_time: f32) {
        let _ = self.inner.reset(requested_time);
    }

    pub fn spawn(
        name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
    ) {
        let handle = tokio::runtime::Handle::current();

        std::thread::spawn(move || Self::run(name, path, fps, rx, ready_tx, handle));
    }

    fn run(
        _name: &'static str,
        path: PathBuf,
        fps: u32,
        rx: mpsc::Receiver<VideoDecoderMessage>,
        ready_tx: oneshot::Sender<Result<(), String>>,
        tokio_handle: tokio::runtime::Handle,
    ) {
        let mut this = match AVAssetReaderDecoder::new(path, tokio_handle) {
            Ok(v) => {
                ready_tx.send(Ok(())).ok();
                v
            }
            Err(e) => {
                ready_tx.send(Err(e)).ok();
                return;
            }
        };

        let mut cache = FrameCache::new();
        let mut last_sent_frame = None::<ProcessedFrame>;
        let mut run_start = None::<u32>;
        let mut last_decoded = None::<u32>;
        let mut last_requested = None::<u32>;

        let mut frames = this.inner.frames();
        let mut processor = ImageBufProcessor::new();

        while let Ok(r) = rx.recv() {
            match r {
                VideoDecoderMessage::GetFrame(requested_time, sender) => {
                    let requested_frame = (requested_time * fps as f32).floor() as u32;
                    if let Some(previous) = last_requested.replace(requested_frame)
                        && previous != requested_frame
                    {
                        cache.backward = requested_frame < previous;
                    }

                    let response = if let Some(data) =
                        cache.processed(requested_frame, &mut processor)
                    {
                        cache.trim(requested_frame);
                        Some(data)
                    } else if let Some(data) = run_start
                        .zip(last_decoded)
                        .filter(|(first, last)| (*first..*last).contains(&requested_frame))
                        .and_then(|(first, _)| {
                            cache.latest_at_or_before(requested_frame, first, &mut processor)
                        })
                    {
                        cache.trim(requested_frame);
                        Some(data)
                    } else {
                        if requested_frame == 0
                            || last_decoded.is_some_and(|last| requested_frame < last)
                            || last_sent_frame.as_ref().is_none_or(|last| {
                                requested_frame < last.number
                                    || requested_frame - last.number > FRAME_CACHE_SIZE as u32
                            })
                        {
                            this.reset(requested_time);
                            frames = this.inner.frames();
                            run_start = None;
                            last_decoded = None;
                        }

                        let mut response = None;

                        for frame in &mut frames {
                            let Ok(frame) = frame.map_err(|e| format!("read frame / {e}")) else {
                                continue;
                            };

                            let pts = frame.pts();
                            let current_frame = if run_start.is_none() {
                                (pts.value as f64 * fps as f64 / pts.scale as f64).floor() as u32
                            } else {
                                pts_to_frame(pts.value, Rational::new(1, pts.scale), fps)
                            };

                            let Some(image_buf) = frame.image_buf() else {
                                continue;
                            };

                            let mut cache_frame = CachedFrame::Raw {
                                image_buf: image_buf.retained(),
                                number: current_frame,
                            };

                            this.is_done = false;
                            let first_in_run = *run_start.get_or_insert(current_frame);
                            last_decoded = Some(current_frame);

                            match current_frame.cmp(&requested_frame) {
                                Ordering::Less => {
                                    cache.insert(current_frame, cache_frame, requested_frame);
                                }
                                Ordering::Equal => {
                                    response = Some(cache_frame.process(&mut processor));
                                    cache.insert(current_frame, cache_frame, requested_frame);
                                    break;
                                }
                                Ordering::Greater => {
                                    response = Some(
                                        match cache.latest_at_or_before(
                                            requested_frame,
                                            first_in_run,
                                            &mut processor,
                                        ) {
                                            Some(previous) => previous,
                                            None => cache_frame.process(&mut processor),
                                        },
                                    );
                                    cache.insert(current_frame, cache_frame, requested_frame);
                                    break;
                                }
                            }
                        }

                        this.is_done = true;

                        response
                            .or_else(|| {
                                cache.latest_at_or_before(requested_frame, 0, &mut processor)
                            })
                            .or_else(|| last_sent_frame.clone())
                    };

                    if let Some(data) = response {
                        let _ = sender.send(DecodedFrame {
                            data: data.data.clone(),
                            width: data.width,
                            height: data.height,
                        });
                        last_sent_frame = Some(data);
                    }
                }
            }
        }
    }
}
