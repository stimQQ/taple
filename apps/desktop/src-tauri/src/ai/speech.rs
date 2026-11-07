use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, PoisonError},
    time::SystemTime,
};

use cap_audio::AudioData;
use cap_project::{RecordingMeta, StudioRecordingMeta};
use ffmpeg::{ChannelLayout, format as avformat, software::resampling};
use serde::Serialize;
use specta::Type;
use tracing::*;

use super::{load_meta, task_error};
use crate::i18n::tr;

pub const SPEECH_SAMPLE_RATE: u32 = 16_000;
pub const VAD_FRAME_SAMPLES: usize = 320;

const VAD_NOISE_PERCENTILE: f64 = 0.1;
const VAD_LOUD_PERCENTILE: f64 = 0.99;
const VAD_NOISE_MARGIN_DB: f32 = 15.0;
const VAD_MIN_NOISE_MARGIN_DB: f32 = 6.0;
const VAD_LOUD_MARGIN_DB: f32 = 12.0;

pub struct VadSettings {
    pub min_voiced_frames: usize,
    pub merge_gap_frames: usize,
    pub min_region_frames: usize,
    pub padding_samples: usize,
}

pub const TRANSCRIPTION_VAD: VadSettings = VadSettings {
    min_voiced_frames: 3,
    merge_gap_frames: 40,
    min_region_frames: 10,
    padding_samples: 6400,
};

const CUTTING_VAD: VadSettings = VadSettings {
    min_voiced_frames: 4,
    merge_gap_frames: 12,
    min_region_frames: 4,
    padding_samples: 0,
};

pub struct SpeechLevels {
    pub noise_floor_db: f32,
    pub threshold_db: f32,
}

pub struct SpeechSource {
    pub path: PathBuf,
    pub offset: f64,
}

#[derive(Serialize, Type, Debug, Clone)]
pub struct SpeechRegion {
    pub segment_index: u32,
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize, Type, Debug, Clone)]
pub struct SpeechActivity {
    pub frame_ms: u32,
    pub noise_floor_db: f64,
    pub speech_db: f64,
    pub regions: Vec<SpeechRegion>,
}

type Fingerprint = Vec<(PathBuf, Option<SystemTime>, u64)>;

static SPEECH_ACTIVITY_CACHE: LazyLock<Mutex<HashMap<PathBuf, (Fingerprint, SpeechActivity)>>> =
    LazyLock::new(Default::default);

fn stream_offset(latest_start_time: Option<f64>, start_time: Option<f64>) -> f64 {
    latest_start_time
        .zip(start_time)
        .map(|(latest, start)| (latest - start).max(0.0))
        .unwrap_or(0.0)
}

pub fn segment_speech_sources(meta: &RecordingMeta) -> Vec<Option<SpeechSource>> {
    match meta.studio_meta() {
        StudioRecordingMeta::SingleSegment { segment } => {
            vec![segment.audio.as_ref().map(|audio| SpeechSource {
                path: meta.path(&audio.path),
                offset: 0.0,
            })]
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| {
                let latest = segment.latest_start_time();
                segment
                    .mic
                    .as_ref()
                    .or(segment.system_audio.as_ref())
                    .map(|audio| SpeechSource {
                        path: meta.path(&audio.path),
                        offset: stream_offset(latest, audio.start_time),
                    })
            })
            .collect(),
    }
}

fn append_resampled(output: &mut Vec<f32>, frame: &ffmpeg::frame::Audio) {
    let byte_len = frame.samples() * std::mem::size_of::<f32>();
    let (chunks, _) = frame.data(0)[..byte_len].as_chunks::<4>();
    output.extend(chunks.iter().map(|bytes| f32::from_ne_bytes(*bytes)));
}

fn resample_to_speech_rate(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
    let format = avformat::Sample::F32(avformat::sample::Type::Packed);
    let resample_error =
        |e: ffmpeg::Error| format!("{}: {e}", tr("音频重采样失败", "Failed to resample audio"));

    let mut resampler = resampling::Context::get(
        format,
        ChannelLayout::MONO,
        sample_rate,
        format,
        ChannelLayout::MONO,
        SPEECH_SAMPLE_RATE,
    )
    .map_err(resample_error)?;

    let mut output = Vec::with_capacity(
        samples.len() * SPEECH_SAMPLE_RATE as usize / sample_rate.max(1) as usize + 4096,
    );
    let mut resampled = ffmpeg::frame::Audio::empty();

    for chunk in samples.chunks(sample_rate.max(1) as usize) {
        let mut frame = ffmpeg::frame::Audio::new(format, chunk.len(), ChannelLayout::MONO);
        frame.set_rate(sample_rate);
        let (bytes, _) = frame.data_mut(0).as_chunks_mut::<4>();
        for (dst, sample) in bytes.iter_mut().zip(chunk) {
            *dst = sample.to_ne_bytes();
        }

        resampler
            .run(&frame, &mut resampled)
            .map_err(resample_error)?;
        append_resampled(&mut output, &resampled);
    }

    loop {
        let delay = resampler.flush(&mut resampled).map_err(resample_error)?;
        append_resampled(&mut output, &resampled);
        if delay.is_none() || resampled.samples() == 0 {
            break;
        }
    }

    Ok(output)
}

pub fn load_speech_audio(path: &Path) -> Result<Vec<f32>, String> {
    let audio = AudioData::from_file(path)
        .map_err(|e| format!("{}: {e}", tr("读取音频失败", "Failed to read audio")))?;

    let channels = usize::from(audio.channels().max(1));
    let mono: Vec<f32> = if channels == 1 {
        audio.samples().to_vec()
    } else {
        audio
            .samples()
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    resample_to_speech_rate(&mono, AudioData::SAMPLE_RATE)
}

fn percentile(sorted: &[f32], fraction: f64) -> f32 {
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

pub fn frame_levels(samples: &[f32]) -> Vec<f32> {
    samples
        .chunks(VAD_FRAME_SAMPLES)
        .map(|frame| {
            let energy = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
            10.0 * energy.max(1e-12).log10()
        })
        .collect()
}

pub fn speech_levels(frame_db: &[f32]) -> Option<SpeechLevels> {
    if frame_db.is_empty() {
        return None;
    }

    let mut sorted = frame_db.to_vec();
    sorted.sort_by(f32::total_cmp);
    let noise_floor_db = percentile(&sorted, VAD_NOISE_PERCENTILE);
    let loud_level = percentile(&sorted, VAD_LOUD_PERCENTILE);
    let threshold_db = (noise_floor_db + VAD_NOISE_MARGIN_DB)
        .min(loud_level - VAD_LOUD_MARGIN_DB)
        .max(noise_floor_db + VAD_MIN_NOISE_MARGIN_DB);

    Some(SpeechLevels {
        noise_floor_db,
        threshold_db,
    })
}

pub fn speech_ranges(
    frame_db: &[f32],
    threshold_db: f32,
    sample_count: usize,
    settings: &VadSettings,
) -> Vec<(usize, usize)> {
    let mut voiced_runs: Vec<(usize, usize)> = Vec::new();
    let mut run_start = None;
    for (index, level) in frame_db
        .iter()
        .chain(std::iter::once(&f32::MIN))
        .enumerate()
    {
        match (run_start, *level >= threshold_db) {
            (None, true) => run_start = Some(index),
            (Some(start), false) => {
                if index - start >= settings.min_voiced_frames {
                    voiced_runs.push((start, index));
                }
                run_start = None;
            }
            _ => {}
        }
    }

    let mut frame_runs: Vec<(usize, usize, usize)> = Vec::new();
    for (start, end) in voiced_runs {
        if let Some(run) = frame_runs.last_mut()
            && start - run.1 <= settings.merge_gap_frames
        {
            run.1 = end;
            run.2 += end - start;
            continue;
        }

        frame_runs.push((start, end, end - start));
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (start_frame, end_frame, active) in frame_runs {
        if active < settings.min_region_frames {
            continue;
        }

        let start = (start_frame * VAD_FRAME_SAMPLES).saturating_sub(settings.padding_samples);
        let end = (end_frame * VAD_FRAME_SAMPLES + settings.padding_samples).min(sample_count);

        if let Some(last) = ranges.last_mut()
            && start <= last.1
        {
            last.1 = last.1.max(end);
            continue;
        }

        ranges.push((start, end));
    }

    ranges
}

fn fingerprint(sources: &[Option<SpeechSource>]) -> Fingerprint {
    sources
        .iter()
        .flatten()
        .map(|source| {
            let metadata = std::fs::metadata(&source.path).ok();
            (
                source.path.clone(),
                metadata.as_ref().and_then(|m| m.modified().ok()),
                metadata.map_or(0, |m| m.len()),
            )
        })
        .collect()
}

fn round_to(value: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    (value * factor).round() / factor
}

fn analyze_speech_activity(project_path: &Path) -> Result<SpeechActivity, String> {
    let meta = load_meta(project_path)?;
    let sources = segment_speech_sources(&meta);
    let key = fingerprint(&sources);

    if let Some((cached_key, activity)) = SPEECH_ACTIVITY_CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(project_path)
        && *cached_key == key
    {
        return Ok(activity.clone());
    }

    let mut segments = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let Some(source) = source else {
            continue;
        };

        if !source.path.exists() {
            warn!("Skipping missing audio for segment {index}");
            continue;
        }

        let samples = load_speech_audio(&source.path)?;
        let levels = frame_levels(&samples);
        segments.push((index as u32, source.offset, samples.len(), levels));
    }

    let all_levels: Vec<f32> = segments
        .iter()
        .flat_map(|(_, _, _, levels)| levels.iter().copied())
        .collect();

    let Some(levels) = speech_levels(&all_levels) else {
        return Err(tr("录制中没有可用的音频", "No audio found in this recording").to_string());
    };

    let mut regions = Vec::new();
    let mut voiced_levels = Vec::new();
    for (segment_index, offset, sample_count, frame_db) in &segments {
        for (start, end) in
            speech_ranges(frame_db, levels.threshold_db, *sample_count, &CUTTING_VAD)
        {
            let to_segment_time =
                |sample: usize| (sample as f64 / f64::from(SPEECH_SAMPLE_RATE) - offset).max(0.0);

            voiced_levels.extend(
                frame_db[start / VAD_FRAME_SAMPLES..end.div_ceil(VAD_FRAME_SAMPLES)]
                    .iter()
                    .copied(),
            );
            regions.push(SpeechRegion {
                segment_index: *segment_index,
                start: round_to(to_segment_time(start), 3),
                end: round_to(to_segment_time(end), 3),
            });
        }
    }

    voiced_levels.sort_by(f32::total_cmp);
    let speech_db = if voiced_levels.is_empty() {
        levels.threshold_db
    } else {
        percentile(&voiced_levels, 0.5)
    };

    let activity = SpeechActivity {
        frame_ms: (VAD_FRAME_SAMPLES as u32 * 1000) / SPEECH_SAMPLE_RATE,
        noise_floor_db: round_to(f64::from(levels.noise_floor_db), 1),
        speech_db: round_to(f64::from(speech_db), 1),
        regions,
    };

    SPEECH_ACTIVITY_CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(project_path.to_path_buf(), (key, activity.clone()));

    Ok(activity)
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_speech_activity(project_path: String) -> Result<SpeechActivity, String> {
    tokio::task::spawn_blocking(move || analyze_speech_activity(Path::new(&project_path)))
        .await
        .map_err(task_error)?
}
