use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use base64::Engine;
use cap_project::{CursorEvents, CursorMoveEvent, RecordingMeta, StudioRecordingMeta};
use cap_rendering::decoder::{DecodedFrame, spawn_decoder};
use ffmpeg::{format::Pixel, software::scaling};
use serde::Serialize;
use specta::Type;
use tracing::*;

use crate::i18n::tr;

pub mod activity;
pub mod speech;
pub mod storyboard;

const FRAME_DECODE_TIMEOUT: Duration = Duration::from_secs(20);
const JPEG_QUALITY: u8 = 80;
const KEYCHAIN_SERVICE: &str = "app.taple.desktop.ai";
const AI_PROVIDERS: [&str; 3] = ["apimodels", "anthropic", "openai"];

static API_KEY_CACHE: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(Default::default);
static KEYCHAIN_ACCESS: Mutex<()> = Mutex::new(());

#[derive(Serialize, Type, Debug, Clone)]
pub struct CursorClickInfo {
    pub segment_index: u32,
    pub time_secs: f64,
    pub x: f64,
    pub y: f64,
}

struct DisplaySource {
    path: PathBuf,
    fps: u32,
    offset: f64,
}

fn load_meta(project_path: &Path) -> Result<RecordingMeta, String> {
    RecordingMeta::load_for_project(project_path).map_err(|e| {
        format!(
            "{}: {e}",
            tr("读取录制信息失败", "Failed to load recording meta")
        )
    })
}

fn segment_not_found(segment_index: u32) -> String {
    format!(
        "{}: {segment_index}",
        tr("找不到录制片段", "Recording segment not found")
    )
}

fn display_source(meta: &RecordingMeta, segment_index: u32) -> Result<DisplaySource, String> {
    match meta.studio_meta() {
        StudioRecordingMeta::SingleSegment { segment } => {
            if segment_index != 0 {
                return Err(segment_not_found(segment_index));
            }

            Ok(DisplaySource {
                path: meta.path(&segment.display.path),
                fps: segment.display.fps,
                offset: 0.0,
            })
        }
        StudioRecordingMeta::MultipleSegments { inner } => {
            let segment = inner
                .segments
                .get(segment_index as usize)
                .ok_or_else(|| segment_not_found(segment_index))?;

            let offset = segment
                .latest_start_time()
                .zip(segment.display.start_time)
                .map(|(latest_start_time, display_start_time)| {
                    latest_start_time - display_start_time
                })
                .unwrap_or(0.0);

            Ok(DisplaySource {
                path: meta.path(&segment.display.path),
                fps: segment.display.fps,
                offset,
            })
        }
    }
}

fn video_duration(path: &Path) -> Result<Option<f64>, String> {
    let input = ffmpeg::format::input(path).map_err(|e| {
        format!(
            "{}: {e}",
            tr("打开屏幕视频失败", "Failed to open screen video")
        )
    })?;

    let duration = input.duration();

    Ok((duration > 0).then(|| duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)))
}

fn encode_frame_jpeg(frame: &DecodedFrame, max_width: u32) -> Result<String, String> {
    let src_width = frame.width();
    let src_height = frame.height();
    let src_row_len = src_width as usize * 4;

    if src_width == 0 || src_height == 0 || frame.data().len() < src_row_len * src_height as usize {
        return Err(tr("解码出的画面无效", "Decoded frame is invalid").to_string());
    }

    let dst_width = max_width.clamp(1, src_width);
    let dst_height = ((f64::from(src_height) * f64::from(dst_width) / f64::from(src_width)).round()
        as u32)
        .max(1);

    let mut src = ffmpeg::frame::Video::new(Pixel::RGBA, src_width, src_height);
    let src_stride = src.stride(0);
    let src_plane = src.data_mut(0);
    for (row, chunk) in frame
        .data()
        .chunks_exact(src_row_len)
        .take(src_height as usize)
        .enumerate()
    {
        let start = row * src_stride;
        src_plane[start..start + src_row_len].copy_from_slice(chunk);
    }

    let scale_error =
        |e: ffmpeg::Error| format!("{}: {e}", tr("缩放画面失败", "Failed to scale frame"));

    let mut scaler = scaling::Context::get(
        Pixel::RGBA,
        src_width,
        src_height,
        Pixel::RGB24,
        dst_width,
        dst_height,
        scaling::Flags::AREA,
    )
    .map_err(scale_error)?;

    let mut dst = ffmpeg::frame::Video::empty();
    scaler.run(&src, &mut dst).map_err(scale_error)?;

    let dst_row_len = dst_width as usize * 3;
    let dst_stride = dst.stride(0);
    let mut rgb = Vec::with_capacity(dst_row_len * dst_height as usize);
    for row in dst.data(0).chunks(dst_stride).take(dst_height as usize) {
        rgb.extend_from_slice(&row[..dst_row_len]);
    }

    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
        .encode(&rgb, dst_width, dst_height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("{}: {e}", tr("编码 JPEG 失败", "Failed to encode JPEG")))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(jpeg))
}

fn task_error(e: tokio::task::JoinError) -> String {
    format!("{}: {e}", tr("后台任务失败", "Background task failed"))
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_frame_jpeg(
    project_path: String,
    segment_index: u32,
    time_secs: f64,
    max_width: u32,
) -> Result<String, String> {
    let (source, duration) = tokio::task::spawn_blocking(move || {
        let meta = load_meta(Path::new(&project_path))?;
        let source = display_source(&meta, segment_index)?;

        if !source.path.exists() {
            return Err(format!(
                "{}: {}",
                tr("找不到屏幕视频文件", "Screen video file not found"),
                source.path.display()
            ));
        }

        let duration = video_duration(&source.path)?;

        Ok((source, duration))
    })
    .await
    .map_err(task_error)??;

    let fps = source.fps.max(1);
    let requested_time = if time_secs.is_finite() {
        time_secs.max(0.0)
    } else {
        0.0
    };
    let time = match duration {
        Some(duration) => {
            requested_time.min((duration - source.offset - 1.0 / f64::from(fps)).max(0.0))
        }
        None => requested_time,
    };

    let decoder = spawn_decoder("ai-frame", source.path, fps, source.offset)
        .await
        .map_err(|e| {
            format!(
                "{}: {e}",
                tr("打开视频解码器失败", "Failed to open video decoder")
            )
        })?;

    let frame = tokio::time::timeout(FRAME_DECODE_TIMEOUT, decoder.get_frame(time as f32))
        .await
        .map_err(|_| tr("解码画面超时", "Timed out decoding frame").to_string())?
        .ok_or_else(|| {
            tr(
                "无法解码该时间点的画面",
                "Could not decode a frame at this time",
            )
            .to_string()
        })?;

    drop(decoder);

    tokio::task::spawn_blocking(move || encode_frame_jpeg(&frame, max_width))
        .await
        .map_err(task_error)?
}

const ON_SCREEN_MARGIN: f64 = 0.01;

fn on_screen(x: f64, y: f64) -> bool {
    let range = -ON_SCREEN_MARGIN..=1.0 + ON_SCREEN_MARGIN;
    range.contains(&x) && range.contains(&y)
}

fn click_position(moves: &[CursorMoveEvent], time_ms: f64) -> Option<(f64, f64)> {
    let mut closest = None;
    let mut closest_diff = f64::MAX;

    for event in moves {
        let diff = (event.time_ms - time_ms).abs();
        if diff < closest_diff {
            closest_diff = diff;
            closest = Some((event.x, event.y));
        }
        if event.time_ms > time_ms {
            break;
        }
    }

    closest
}

fn collect_cursor_clicks(project_path: &Path) -> Result<Vec<CursorClickInfo>, String> {
    let meta = load_meta(project_path)?;

    let cursor_paths: Vec<Option<PathBuf>> = match meta.studio_meta() {
        StudioRecordingMeta::SingleSegment { segment } => {
            vec![segment.cursor.as_ref().map(|path| meta.path(path))]
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .iter()
            .map(|segment| segment.cursor.as_ref().map(|path| meta.path(path)))
            .collect(),
    };

    let mut clicks = Vec::new();

    for (segment_index, path) in cursor_paths.into_iter().enumerate() {
        let Some(path) = path.filter(|path| path.exists()) else {
            continue;
        };

        let mut events = match CursorEvents::load_from_file(&path) {
            Ok(events) => events,
            Err(e) => {
                warn!("Skipping cursor events for segment {segment_index}: {e}");
                continue;
            }
        };

        events.moves.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

        for click in events.clicks.iter().filter(|click| click.down) {
            let Some((x, y)) = click_position(&events.moves, click.time_ms) else {
                continue;
            };

            if !on_screen(x, y) {
                continue;
            }

            clicks.push(CursorClickInfo {
                segment_index: segment_index as u32,
                time_secs: click.time_ms / 1000.0,
                x,
                y,
            });
        }
    }

    clicks.sort_by(|a, b| {
        a.segment_index
            .cmp(&b.segment_index)
            .then(a.time_secs.total_cmp(&b.time_secs))
    });

    Ok(clicks)
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_cursor_clicks(project_path: String) -> Result<Vec<CursorClickInfo>, String> {
    tokio::task::spawn_blocking(move || collect_cursor_clicks(Path::new(&project_path)))
        .await
        .map_err(task_error)?
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if AI_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!(
            "{}: {provider}",
            tr("不支持的 AI 服务商", "Unsupported AI provider")
        ))
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use security_framework::passwords;

    use super::KEYCHAIN_SERVICE;
    use crate::i18n::tr;

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
    const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
                tr(
                    "钥匙串中保存的 API 密钥格式无效",
                    "The API key stored in Keychain is invalid",
                )
                .to_string()
            }),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(format!(
                "{}: {e}",
                tr(
                    "从钥匙串读取 API 密钥失败",
                    "Failed to read API key from Keychain"
                )
            )),
        }
    }

    pub fn set(account: &str, api_key: &str) -> Result<(), String> {
        let failed = |e: security_framework::base::Error| {
            format!(
                "{}: {e}",
                tr(
                    "保存 API 密钥到钥匙串失败",
                    "Failed to save API key to Keychain"
                )
            )
        };

        match passwords::set_generic_password(KEYCHAIN_SERVICE, account, api_key.as_bytes()) {
            Ok(()) => Ok(()),
            Err(e)
                if matches!(
                    e.code(),
                    ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_DUPLICATE_ITEM
                ) =>
            {
                delete(account)?;
                passwords::set_generic_password(KEYCHAIN_SERVICE, account, api_key.as_bytes())
                    .map_err(failed)
            }
            Err(e) => Err(failed(e)),
        }
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match passwords::delete_generic_password(KEYCHAIN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(format!(
                "{}: {e}",
                tr(
                    "从钥匙串删除 API 密钥失败",
                    "Failed to delete API key from Keychain"
                )
            )),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use crate::i18n::tr;

    fn unsupported() -> String {
        tr(
            "当前系统不支持钥匙串存储",
            "Keychain storage is not supported on this platform",
        )
        .to_string()
    }

    pub fn get(_account: &str) -> Result<Option<String>, String> {
        Err(unsupported())
    }

    pub fn set(_account: &str, _api_key: &str) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn delete(_account: &str) -> Result<(), String> {
        Err(unsupported())
    }
}

fn keychain_access() -> MutexGuard<'static, ()> {
    KEYCHAIN_ACCESS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn api_key_cache() -> MutexGuard<'static, HashMap<String, Option<String>>> {
    API_KEY_CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn ai_get_api_key(provider: String) -> Result<Option<String>, String> {
    validate_provider(&provider)?;

    tokio::task::spawn_blocking(move || {
        let _access = keychain_access();

        if let Some(cached) = api_key_cache().get(&provider) {
            return Ok(cached.clone());
        }

        let api_key = keychain::get(&provider)?;
        api_key_cache().insert(provider, api_key.clone());
        Ok(api_key)
    })
    .await
    .map_err(task_error)?
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(api_key))]
pub async fn ai_set_api_key(provider: String, api_key: String) -> Result<(), String> {
    validate_provider(&provider)?;

    let api_key = api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(tr("API 密钥不能为空", "API key cannot be empty").to_string());
    }

    tokio::task::spawn_blocking(move || {
        let _access = keychain_access();
        keychain::set(&provider, &api_key)?;
        api_key_cache().insert(provider, Some(api_key));
        Ok(())
    })
    .await
    .map_err(task_error)?
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn ai_delete_api_key(provider: String) -> Result<(), String> {
    validate_provider(&provider)?;

    tokio::task::spawn_blocking(move || {
        let _access = keychain_access();
        keychain::delete(&provider)?;
        api_key_cache().insert(provider, None);
        Ok(())
    })
    .await
    .map_err(task_error)?
}
