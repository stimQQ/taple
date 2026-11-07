use crate::i18n::tr;
use cap_audio::AudioData;
use cap_project::{RecordingMeta, StudioRecordingMeta};
#[cfg(not(target_arch = "aarch64"))]
use df::offline::DfOffline as Denoiser;
#[cfg(target_arch = "aarch64")]
use df::ort_impl::DfOrt as Denoiser;
use df::tract::{DfParams, RuntimeParams};
use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct DenoiseProgress {
    pub progress: f64,
    pub status: String,
}

fn microphone_paths(recording_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let meta = RecordingMeta::load_for_project(recording_dir).map_err(|e| {
        format!(
            "{}: {e}",
            tr("读取录制信息失败", "Failed to load recording meta")
        )
    })?;

    let paths: Vec<PathBuf> = match meta.studio_meta() {
        StudioRecordingMeta::SingleSegment { segment } => segment
            .audio
            .iter()
            .map(|audio| meta.path(&audio.path))
            .collect(),
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .filter_map(|segment| segment.mic.as_ref().map(|mic| meta.path(&mic.path)))
            .collect(),
    };

    Ok(paths.into_iter().filter(|path| path.exists()).collect())
}

fn sibling_path(path: &Path, tag: &str) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("ogg");
    path.with_extension(format!("{tag}.{extension}"))
}

fn original_path(path: &Path) -> PathBuf {
    sibling_path(path, "original")
}

async fn reload_editors(app: &AppHandle, recording_dir: &Path) -> Result<(), String> {
    let Some(instances) = app.try_state::<crate::editor_window::EditorInstances>() else {
        return Ok(());
    };

    for instance in instances.for_project(recording_dir).await {
        instance
            .reload_microphone_audio()
            .await
            .map_err(|e| format!("{}: {e}", tr("重新载入音频失败", "Failed to reload audio")))?;
    }

    Ok(())
}

fn denoise_samples(
    model: &mut Denoiser,
    samples: &[f32],
    channels: usize,
) -> Result<Vec<f32>, String> {
    let mono: Vec<f32> = if channels <= 1 {
        samples.to_vec()
    } else {
        samples
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect()
    };

    let enhanced = model
        .process_audio(&mono)
        .map_err(|e| format!("{}: {e}", tr("降噪处理失败", "Noise reduction failed")))?;

    if channels <= 1 {
        return Ok(enhanced);
    }

    Ok(enhanced
        .iter()
        .flat_map(|sample| std::iter::repeat_n(*sample, channels))
        .collect())
}

fn replace_with_denoised(path: &Path, denoised: &Path) -> Result<(), String> {
    let original = original_path(path);
    let failed =
        |e: std::io::Error| format!("{}: {e}", tr("替换文件失败", "Failed to replace file"));

    if !original.exists() {
        std::fs::rename(path, &original).map_err(failed)?;
        if let Err(e) = std::fs::rename(denoised, path) {
            std::fs::rename(&original, path).ok();
            return Err(failed(e));
        }
        return Ok(());
    }

    std::fs::rename(denoised, path).map_err(failed)
}

#[tauri::command]
#[specta::specta]
pub async fn denoise_recording_audio(app: AppHandle, recording_path: String) -> Result<(), String> {
    let recording_dir = PathBuf::from(&recording_path);
    let paths = microphone_paths(&recording_dir)?;
    if paths.is_empty() {
        return Err(tr("未找到麦克风音频文件", "Microphone audio file not found").to_string());
    }

    emit_progress(
        &app,
        0.02,
        tr("正在加载降噪模型...", "Loading noise reduction model..."),
    );

    let total = paths.len() as f64;
    let progress_app = app.clone();
    let outputs =
        tokio::task::spawn_blocking(move || -> Result<Vec<(PathBuf, PathBuf)>, String> {
            let params = RuntimeParams::default_with_ch(1).with_thresholds(-15., 35., 35.);
            let mut model = Denoiser::new(DfParams::default(), &params).map_err(|e| {
                format!(
                    "{}: {e}",
                    tr(
                        "加载降噪模型失败",
                        "Failed to load the noise reduction model"
                    )
                )
            })?;

            let mut outputs = Vec::with_capacity(paths.len());
            for (index, path) in paths.iter().enumerate() {
                let step = |fraction: f64| 0.05 + 0.9 * (index as f64 + fraction) / total;
                emit_progress(
                    &progress_app,
                    step(0.0),
                    tr("正在读取音频...", "Reading audio..."),
                );

                let original = original_path(path);
                let source = if original.exists() { &original } else { path };
                let audio = AudioData::from_file(source)
                    .map_err(|e| format!("{}: {e}", tr("读取音频失败", "Failed to read audio")))?;
                let channels = audio.channels() as usize;

                emit_progress(
                    &progress_app,
                    step(0.2),
                    tr("正在降噪处理...", "Reducing noise..."),
                );
                let denoised = denoise_samples(&mut model, audio.samples(), channels)?;

                emit_progress(
                    &progress_app,
                    step(0.8),
                    tr("正在编码输出...", "Encoding output..."),
                );
                let output = sibling_path(path, "denoising");
                encode_ogg(&denoised, channels, &output).map_err(|e| {
                    std::fs::remove_file(&output).ok();
                    format!("{}: {e}", tr("编码失败", "Encoding failed"))
                })?;
                outputs.push((path.clone(), output));
            }

            Ok(outputs)
        })
        .await
        .map_err(|e| format!("{}: {e}", tr("降噪任务失败", "Noise reduction task failed")))??;

    for (path, output) in &outputs {
        if let Err(e) = replace_with_denoised(path, output) {
            for (_, pending) in &outputs {
                std::fs::remove_file(pending).ok();
            }
            return Err(e);
        }
    }

    emit_progress(
        &app,
        0.97,
        tr("正在载入新音频...", "Loading the new audio..."),
    );
    reload_editors(&app, &recording_dir).await?;
    emit_progress(&app, 1.0, tr("降噪完成", "Noise reduction complete"));

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn has_original_audio(recording_path: String) -> Result<bool, String> {
    Ok(microphone_paths(Path::new(&recording_path))?
        .iter()
        .any(|path| original_path(path).exists()))
}

#[tauri::command]
#[specta::specta]
pub async fn restore_original_audio(app: AppHandle, recording_path: String) -> Result<(), String> {
    let recording_dir = PathBuf::from(&recording_path);
    for path in microphone_paths(&recording_dir)? {
        let original = original_path(&path);
        if original.exists() {
            std::fs::rename(&original, &path).map_err(|e| {
                format!(
                    "{}: {e}",
                    tr("恢复原始音频失败", "Failed to restore original audio")
                )
            })?;
        }
    }

    reload_editors(&app, &recording_dir).await
}

const TARGET_LOUDNESS_LUFS: f64 = -16.0;
const MAX_PEAK_AFTER_GAIN_DB: f64 = 3.0;
const MIN_VOLUME_DB: f64 = -30.0;
const MAX_VOLUME_DB: f64 = 30.0;
const PEAK_PERCENTILE: f64 = 0.99995;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MicLevel {
    pub loudness_lufs: f32,
    pub peak_dbfs: f32,
    pub recommended_volume_db: f32,
}

struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Self { b, a, z: [0.0; 2] }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

fn k_weighting() -> [Biquad; 2] {
    [
        Biquad::new(
            [
                1.535_124_859_586_97,
                -2.691_696_189_406_38,
                1.198_392_810_852_85,
            ],
            [-1.690_659_293_182_41, 0.732_480_774_215_85],
        ),
        Biquad::new(
            [1.0, -2.0, 1.0],
            [-1.990_047_454_833_98, 0.990_072_250_366_21],
        ),
    ]
}

fn loudness(power: f64) -> f64 {
    -0.691 + 10.0 * power.max(1e-20).log10()
}

fn block_powers(samples: &[f32], channels: usize, sample_rate: usize) -> Vec<f64> {
    let channels = channels.max(1);
    let step = sample_rate / 10;
    let frames = samples.len() / channels;
    let mut filters: Vec<[Biquad; 2]> = (0..channels).map(|_| k_weighting()).collect();
    let playback_weight = if channels == 1 { 2.0 } else { 1.0 };

    let mut sub_blocks = Vec::with_capacity(frames / step + 1);
    let mut energy = 0.0;
    for frame in 0..frames {
        for (channel, filter) in filters.iter_mut().enumerate() {
            let x = f64::from(samples[frame * channels + channel]);
            let shelved = filter[0].process(x);
            let y = filter[1].process(shelved);
            energy += y * y;
        }
        if (frame + 1) % step == 0 {
            sub_blocks.push(energy * playback_weight / step as f64);
            energy = 0.0;
        }
    }

    sub_blocks
        .windows(4)
        .map(|window| window.iter().sum::<f64>() / 4.0)
        .collect()
}

fn integrated_loudness(blocks: &[f64]) -> Option<f64> {
    let audible: Vec<f64> = blocks
        .iter()
        .copied()
        .filter(|power| loudness(*power) > -70.0)
        .collect();
    if audible.is_empty() {
        return None;
    }

    let relative_gate = loudness(audible.iter().sum::<f64>() / audible.len() as f64) - 10.0;
    let gated: Vec<f64> = audible
        .into_iter()
        .filter(|power| loudness(*power) > relative_gate)
        .collect();
    if gated.is_empty() {
        return None;
    }

    Some(loudness(gated.iter().sum::<f64>() / gated.len() as f64))
}

fn robust_peak_db(histogram: &[u64], total: u64) -> f64 {
    let allowed = ((1.0 - PEAK_PERCENTILE) * total as f64).floor() as u64;
    let mut above = 0;
    for (bin, count) in histogram.iter().enumerate().rev() {
        above += count;
        if above > allowed {
            return bin as f64 / 10.0 - 100.0;
        }
    }
    -100.0
}

fn recommended_volume_db(loudness_lufs: f64, peak_dbfs: f64) -> f64 {
    let for_loudness = TARGET_LOUDNESS_LUFS - loudness_lufs;
    let for_peak = MAX_PEAK_AFTER_GAIN_DB - peak_dbfs;
    let volume = for_loudness
        .min(for_peak)
        .clamp(MIN_VOLUME_DB, MAX_VOLUME_DB);
    (volume * 2.0).round() / 2.0
}

fn measure_mic_level(paths: &[PathBuf]) -> Result<Option<MicLevel>, String> {
    let mut blocks = Vec::new();
    let mut histogram = vec![0u64; 1001];
    let mut total = 0u64;

    for path in paths {
        let audio = AudioData::from_file(path)
            .map_err(|e| format!("{}: {e}", tr("读取音频失败", "Failed to read audio")))?;
        let samples = audio.samples();
        blocks.extend(block_powers(
            samples,
            audio.channels() as usize,
            AudioData::SAMPLE_RATE as usize,
        ));
        for sample in samples {
            let db = 20.0 * f64::from(sample.abs()).max(1e-5).log10();
            let bin = ((db + 100.0) * 10.0).round().clamp(0.0, 1000.0) as usize;
            histogram[bin] += 1;
        }
        total += samples.len() as u64;
    }

    let Some(loudness_lufs) = integrated_loudness(&blocks) else {
        return Ok(None);
    };
    let peak_dbfs = robust_peak_db(&histogram, total);

    Ok(Some(MicLevel {
        loudness_lufs: loudness_lufs as f32,
        peak_dbfs: peak_dbfs as f32,
        recommended_volume_db: recommended_volume_db(loudness_lufs, peak_dbfs) as f32,
    }))
}

#[tauri::command]
#[specta::specta]
pub async fn analyze_mic_level(recording_path: String) -> Result<Option<MicLevel>, String> {
    let paths = microphone_paths(Path::new(&recording_path))?;
    if paths.is_empty() {
        return Ok(None);
    }

    tokio::task::spawn_blocking(move || measure_mic_level(&paths))
        .await
        .map_err(|e| e.to_string())?
}

fn emit_progress(app: &AppHandle, progress: f64, status: &str) {
    use tauri_specta::Event;
    let _ = DenoiseProgress {
        progress,
        status: status.to_string(),
    }
    .emit(app);
}

fn encode_ogg(samples: &[f32], channels: usize, output_path: &Path) -> Result<(), String> {
    let channel_layout = if channels == 1 {
        ChannelLayout::MONO
    } else {
        ChannelLayout::STEREO
    };

    let codec = avcodec::encoder::find_by_name("libopus")
        .ok_or_else(|| tr("libopus 编码器未找到", "libopus encoder not found").to_string())?;

    let mut output = avformat::output(output_path).map_err(|e| {
        format!(
            "{}: {e}",
            tr("创建输出文件失败", "Failed to create output file")
        )
    })?;

    let mut encoder = avcodec::Context::new_with_codec(codec)
        .encoder()
        .audio()
        .map_err(|e| format!("{}: {e}", tr("创建编码器失败", "Failed to create encoder")))?;

    encoder.set_bit_rate(128_000);
    encoder.set_rate(AudioData::SAMPLE_RATE as i32);
    encoder.set_channel_layout(channel_layout);
    encoder.set_format(avformat::Sample::F32(avformat::sample::Type::Packed));
    encoder.set_time_base(ffmpeg::Rational(1, AudioData::SAMPLE_RATE as i32));

    let mut encoder = encoder
        .open()
        .map_err(|e| format!("{}: {e}", tr("打开编码器失败", "Failed to open encoder")))?;

    let mut stream = output
        .add_stream(codec)
        .map_err(|e| format!("{}: {e}", tr("添加流失败", "Failed to add stream")))?;
    stream.set_time_base(ffmpeg::Rational(1, AudioData::SAMPLE_RATE as i32));
    stream.set_parameters(&encoder);

    output
        .write_header()
        .map_err(|e| format!("{}: {e}", tr("写入头部失败", "Failed to write header")))?;

    let frame_size = encoder.frame_size() as usize;
    let frame_size = if frame_size == 0 { 960 } else { frame_size };
    let mut pts = 0i64;

    for chunk in samples.chunks(frame_size * channels) {
        let nb_samples = chunk.len() / channels;
        let mut frame = ffmpeg::frame::Audio::new(
            avformat::Sample::F32(avformat::sample::Type::Packed),
            nb_samples,
            channel_layout,
        );
        frame.set_rate(AudioData::SAMPLE_RATE);
        frame.set_pts(Some(pts));
        pts += nb_samples as i64;

        let plane = frame.plane_mut::<f32>(0);
        plane[..chunk.len()].copy_from_slice(chunk);

        encoder
            .send_frame(&frame)
            .map_err(|e| format!("{}: {e}", tr("发送帧失败", "Failed to send frame")))?;

        flush_encoder(&mut encoder, &mut output)?;
    }

    encoder
        .send_eof()
        .map_err(|e| format!("{}: {e}", tr("发送 EOF 失败", "Failed to send EOF")))?;
    flush_encoder(&mut encoder, &mut output)?;

    output
        .write_trailer()
        .map_err(|e| format!("{}: {e}", tr("写入尾部失败", "Failed to write trailer")))?;

    Ok(())
}

fn flush_encoder(
    encoder: &mut avcodec::encoder::Audio,
    output: &mut avformat::context::Output,
) -> Result<(), String> {
    let mut packet = ffmpeg::Packet::empty();
    while encoder.receive_packet(&mut packet).is_ok() {
        packet
            .write_interleaved(output)
            .map_err(|e| format!("{}: {e}", tr("写入数据包失败", "Failed to write packet")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        block_powers, integrated_loudness, original_path, recommended_volume_db,
        replace_with_denoised, sibling_path,
    };
    use std::path::Path;

    fn sine(amplitude: f32, seconds: usize) -> Vec<f32> {
        (0..48_000 * seconds)
            .map(|i| amplitude * (2.0 * std::f32::consts::PI * 997.0 * i as f32 / 48_000.0).sin())
            .collect()
    }

    #[test]
    fn measures_a_reference_tone() {
        let mono = integrated_loudness(&block_powers(&sine(0.1, 10), 1, 48_000)).unwrap();
        assert!((mono - -20.0).abs() < 0.2, "{mono}");

        let tone = sine(0.1, 10);
        let stereo: Vec<f32> = tone.iter().flat_map(|s| [*s, 0.0]).collect();
        let one_side = integrated_loudness(&block_powers(&stereo, 2, 48_000)).unwrap();
        assert!((one_side - -23.01).abs() < 0.2, "{one_side}");
    }

    #[test]
    fn ignores_silence_when_measuring() {
        let mut samples = sine(0.1, 5);
        samples.extend(std::iter::repeat_n(0.0, 48_000 * 20));
        let measured = integrated_loudness(&block_powers(&samples, 1, 48_000)).unwrap();
        assert!((measured - -20.0).abs() < 0.3, "{measured}");
        assert!(integrated_loudness(&block_powers(&vec![0.0; 48_000 * 5], 1, 48_000)).is_none());
    }

    #[test]
    fn recommends_gain_within_peak_and_range_limits() {
        assert_eq!(recommended_volume_db(-36.0, -20.0), 20.0);
        assert_eq!(recommended_volume_db(-36.0, -6.0), 9.0);
        assert_eq!(recommended_volume_db(-80.0, -60.0), 30.0);
        assert_eq!(recommended_volume_db(-5.0, -1.0), -11.0);
    }

    #[test]
    fn sibling_names_keep_the_extension() {
        let path = Path::new("/r/content/segments/segment-0/audio-input.ogg");
        assert_eq!(
            original_path(path),
            Path::new("/r/content/segments/segment-0/audio-input.original.ogg")
        );
        assert_eq!(
            sibling_path(path, "denoising"),
            Path::new("/r/content/segments/segment-0/audio-input.denoising.ogg")
        );
    }

    #[test]
    fn keeps_the_first_original_across_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio-input.ogg");
        let output = dir.path().join("audio-input.denoising.ogg");

        std::fs::write(&path, "original").unwrap();
        std::fs::write(&output, "first pass").unwrap();
        replace_with_denoised(&path, &output).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first pass");
        assert_eq!(
            std::fs::read_to_string(original_path(&path)).unwrap(),
            "original"
        );
        assert!(!output.exists());

        std::fs::write(&output, "second pass").unwrap();
        replace_with_denoised(&path, &output).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second pass");
        assert_eq!(
            std::fs::read_to_string(original_path(&path)).unwrap(),
            "original"
        );
    }
}
