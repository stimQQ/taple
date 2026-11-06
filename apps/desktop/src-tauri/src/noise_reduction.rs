use crate::i18n::tr;
use cap_audio::AudioData;
use df::ort_impl::DfOrt;
use df::tract::{DfParams, RuntimeParams};
use ffmpeg::{
    ChannelLayout, codec as avcodec,
    format::{self as avformat},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};
use tempfile::tempdir;

const STATUS_LOADING: u64 = 0;
const STATUS_PROCESSING: u64 = 1;
const STATUS_DONE: u64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct DenoiseProgress {
    pub progress: f64,
    pub status: String,
}

#[tauri::command]
#[specta::specta]
pub async fn denoise_recording_audio(app: AppHandle, recording_path: String) -> Result<(), String> {
    let recording_dir = PathBuf::from(&recording_path);
    let audio_input_path = recording_dir
        .join("content")
        .join("segments")
        .join("segment-0")
        .join("audio-input.ogg");

    if !audio_input_path.exists() {
        return Err(tr("未找到麦克风音频文件", "Microphone audio file not found").to_string());
    }

    emit_progress(&app, 0.05, tr("正在读取音频...", "Reading audio..."));

    let audio = AudioData::from_file(&audio_input_path)
        .map_err(|e| format!("{}: {e}", tr("读取音频失败", "Failed to read audio")))?;

    let channels = audio.channels() as usize;
    let samples = audio.samples().to_vec();
    let stage = Arc::new(AtomicU64::new(STATUS_LOADING));

    let st = stage.clone();

    let task = tokio::task::spawn_blocking(move || -> Result<Vec<f32>, String> {
        let df_params = DfParams::default();
        let r_params = RuntimeParams::default_with_ch(1).with_thresholds(-15., 35., 35.);

        st.store(STATUS_PROCESSING, Ordering::Relaxed);

        let mut model = DfOrt::new(df_params, &r_params).map_err(|e| {
            format!(
                "{}: {e}",
                tr(
                    "加载 DeepFilterNet ORT 模型失败",
                    "Failed to load DeepFilterNet ORT model"
                )
            )
        })?;

        let mono_samples: Vec<f32> = if channels == 1 {
            samples.to_vec()
        } else {
            samples.chunks(channels).map(|ch| ch[0]).collect()
        };

        let enhanced_mono = model.process_audio(&mono_samples).map_err(|e| {
            format!(
                "{}: {e}",
                tr("ORT 降噪处理失败", "ORT noise reduction failed")
            )
        })?;

        st.store(STATUS_DONE, Ordering::Relaxed);

        if channels == 1 {
            Ok(enhanced_mono)
        } else {
            let mut interleaved = Vec::with_capacity(enhanced_mono.len() * channels);
            for &s in &enhanced_mono {
                for _ in 0..channels {
                    interleaved.push(s);
                }
            }
            Ok(interleaved)
        }
    });

    let progress_app = app.clone();
    let monitor_st = stage.clone();

    let monitor = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let current_stage = monitor_st.load(Ordering::Relaxed);
            if current_stage == STATUS_LOADING {
                emit_progress(
                    &progress_app,
                    0.10,
                    tr("正在加载降噪模型...", "Loading noise reduction model..."),
                );
            } else if current_stage == STATUS_PROCESSING {
                emit_progress(
                    &progress_app,
                    0.50,
                    tr("正在降噪处理...", "Reducing noise..."),
                );
            } else {
                break;
            }
        }
    });

    let denoised = task
        .await
        .map_err(|e| format!("{}: {e}", tr("降噪任务失败", "Noise reduction task failed")))?
        .map_err(|e| format!("{}: {e}", tr("降噪处理失败", "Noise reduction failed")))?;

    monitor.abort();

    emit_progress(&app, 0.90, tr("正在编码输出...", "Encoding output..."));

    let temp_dir = tempdir().map_err(|e| {
        format!(
            "{}: {e}",
            tr("临时目录创建失败", "Failed to create temporary directory")
        )
    })?;
    let output_path = temp_dir.path().join("denoised.ogg");

    encode_ogg(&denoised, channels, &output_path)
        .map_err(|e| format!("{}: {e}", tr("编码失败", "Encoding failed")))?;

    std::fs::copy(&output_path, &audio_input_path)
        .map_err(|e| format!("{}: {e}", tr("替换文件失败", "Failed to replace file")))?;

    emit_progress(&app, 0.95, tr("正在刷新编辑器...", "Refreshing editor..."));

    if let Some(instances) = app.try_state::<crate::editor_window::EditorInstances>() {
        instances.clear().await;
    }

    emit_progress(&app, 1.0, tr("降噪完成", "Noise reduction complete"));

    Ok(())
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
