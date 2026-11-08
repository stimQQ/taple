use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::*;

use crate::{captions::DownloadProgress, http_client::HttpClient, i18n::tr};

pub const MODEL_FOLDER: &str = "transcription_models";
pub const DEFAULT_MODEL: &str = "small";
const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const AUTO_DOWNLOAD_MARKER: &str = ".auto-download";
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const START_DELAY: Duration = Duration::from_secs(5);
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(30),
    Duration::from_secs(120),
    Duration::from_secs(600),
];
const REPORT_STEP: f64 = 0.5;

struct ModelFile {
    name: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

impl ModelFile {
    fn url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{}",
            self.file
        )
    }
}

const MODELS: &[ModelFile] = &[
    ModelFile {
        name: "tiny",
        file: "ggml-tiny.bin",
        size: 77_691_713,
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    },
    ModelFile {
        name: "base",
        file: "ggml-base.bin",
        size: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelFile {
        name: "small",
        file: "ggml-small.bin",
        size: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
    ModelFile {
        name: "medium",
        file: "ggml-medium.bin",
        size: 1_533_763_059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    },
    ModelFile {
        name: "large-v3",
        file: "ggml-large-v3.bin",
        size: 3_095_033_483,
        sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    },
];

fn find(name: &str) -> Option<&'static ModelFile> {
    let name = if name == "large" { "large-v3" } else { name };
    MODELS.iter().find(|model| model.name == name)
}

pub fn is_ready(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let known = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(find);
    match known {
        Some(model) => metadata.len() == model.size,
        None => metadata.len() > 0,
    }
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(MODEL_FOLDER))
        .map_err(|e| e.to_string())
}

#[derive(Default)]
pub struct SpeechModelDownloads {
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    active: Mutex<HashMap<String, f64>>,
}

impl SpeechModelDownloads {
    fn lock_for(&self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(path.to_path_buf()).or_default().clone()
    }

    fn report(&self, app: &AppHandle, model: &str, progress: f64) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(model.to_string(), progress);
        DownloadProgress {
            model: model.to_string(),
            progress,
            message: format!("Downloading model: {progress:.1}%"),
        }
        .emit(app)
        .ok();
    }

    fn finish(&self, model: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(model);
    }

    fn snapshot(&self) -> Vec<DownloadProgress> {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(model, progress)| DownloadProgress {
                model: model.clone(),
                progress: *progress,
                message: format!("Downloading model: {progress:.1}%"),
            })
            .collect()
    }
}

pub async fn download(app: &AppHandle, name: &str, target: &Path) -> Result<(), String> {
    let model = find(name)
        .ok_or_else(|| format!("{}{name}", tr("未知的语音模型：", "Unknown speech model: ")))?;
    let downloads = app.state::<SpeechModelDownloads>();
    let lock = downloads.lock_for(target);
    let _guard = lock.lock().await;
    if is_ready(target) {
        return Ok(());
    }

    let client = reqwest::Client::clone(&app.state::<HttpClient>());
    let result = fetch(&client, model, target, |progress| {
        downloads.report(app, model.name, progress)
    })
    .await;
    if result.is_ok() {
        downloads.report(app, model.name, 100.0);
    }
    downloads.finish(model.name);
    match &result {
        Ok(()) => info!("Downloaded speech model {}", model.name),
        Err(error) => warn!("Speech model {} download failed: {error}", model.name),
    }
    result
}

async fn hash_partial(partial: &Path, hasher: &mut Sha256) -> std::io::Result<u64> {
    let mut file = tokio::fs::File::open(partial).await?;
    let mut buffer = vec![0u8; 1 << 20];
    let mut total = 0;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok(total);
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

async fn fetch(
    client: &reqwest::Client,
    model: &ModelFile,
    target: &Path,
    mut report: impl FnMut(f64),
) -> Result<(), String> {
    let failed = |detail: String| {
        format!(
            "{}{detail}",
            tr("语音模型下载失败：", "Speech model download failed: ")
        )
    };

    if let Some(dir) = target.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| failed(e.to_string()))?;
    }

    let partial = target.with_extension("part");
    let mut hasher = Sha256::new();
    let mut done = match hash_partial(&partial, &mut hasher).await {
        Ok(len) if len > 0 && len < model.size => len,
        _ => {
            hasher = Sha256::new();
            tokio::fs::remove_file(&partial).await.ok();
            0
        }
    };

    let mut request = client.get(model.url());
    if done > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={done}-"));
    }
    let mut response = request.send().await.map_err(|e| failed(e.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            tokio::fs::remove_file(&partial).await.ok();
        }
        return Err(failed(format!("HTTP {status}")));
    }

    let resumed = done > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !resumed {
        done = 0;
        hasher = Sha256::new();
    }
    let mut output = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&partial)
            .await
    } else {
        tokio::fs::File::create(&partial).await
    }
    .map_err(|e| failed(e.to_string()))?;

    let mut last_reported = done as f64 / model.size as f64 * 100.0;
    report(last_reported);

    loop {
        let chunk = tokio::time::timeout(STALL_TIMEOUT, response.chunk())
            .await
            .map_err(|_| failed(tr("网络长时间没有响应", "the connection stalled").to_string()))?
            .map_err(|e| failed(e.to_string()))?;
        let Some(chunk) = chunk else {
            break;
        };
        done += chunk.len() as u64;
        if done > model.size {
            drop(output);
            tokio::fs::remove_file(&partial).await.ok();
            return Err(failed(
                tr("文件比预期的大", "the file is larger than expected").to_string(),
            ));
        }
        hasher.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|e| failed(e.to_string()))?;

        let progress = done as f64 / model.size as f64 * 100.0;
        if progress - last_reported >= REPORT_STEP {
            last_reported = progress;
            report(progress);
        }
    }
    output.flush().await.map_err(|e| failed(e.to_string()))?;
    drop(output);

    if done < model.size {
        return Err(failed(
            tr("下载没有完成", "the download ended early").to_string(),
        ));
    }

    let hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if hex != model.sha256 {
        tokio::fs::remove_file(&partial).await.ok();
        return Err(failed(
            tr("文件校验不一致", "checksum mismatch").to_string(),
        ));
    }

    tokio::fs::rename(&partial, target)
        .await
        .map_err(|e| failed(e.to_string()))
}

fn has_ready_model(dir: &Path) -> bool {
    MODELS
        .iter()
        .any(|model| is_ready(&dir.join(format!("{}.bin", model.name))))
}

fn mark_auto_download_done(dir: &Path) {
    std::fs::write(dir.join(AUTO_DOWNLOAD_MARKER), b"").ok();
}

pub fn start_auto_download(app: AppHandle) {
    tokio::spawn(async move {
        let Ok(dir) = model_dir(&app) else {
            return;
        };
        if dir.join(AUTO_DOWNLOAD_MARKER).exists() {
            return;
        }
        if has_ready_model(&dir) {
            mark_auto_download_done(&dir);
            return;
        }

        tokio::time::sleep(START_DELAY).await;
        let target = dir.join(format!("{DEFAULT_MODEL}.bin"));
        let mut delays = RETRY_DELAYS.iter();
        loop {
            match download(&app, DEFAULT_MODEL, &target).await {
                Ok(()) => {
                    mark_auto_download_done(&dir);
                    return;
                }
                Err(_) => {
                    let Some(delay) = delays.next() else {
                        return;
                    };
                    tokio::time::sleep(*delay).await;
                }
            }
        }
    });
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn speech_model_downloads(app: AppHandle) -> Vec<DownloadProgress> {
    app.state::<SpeechModelDownloads>().snapshot()
}

#[cfg(test)]
mod tests {
    use super::{MODELS, fetch, find, is_ready};

    #[test]
    fn catalog_is_consistent() {
        for model in MODELS {
            assert_eq!(model.file, format!("ggml-{}.bin", model.name));
            assert_eq!(model.sha256.len(), 64);
        }
        assert_eq!(find("large").map(|model| model.name), Some("large-v3"));
        assert!(find("huge").is_none());
    }

    #[test]
    fn rejects_truncated_models() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("small.bin");
        std::fs::write(&small, b"partial").unwrap();
        assert!(!is_ready(&small));
        let custom = dir.path().join("custom.bin");
        std::fs::write(&custom, b"weights").unwrap();
        assert!(is_ready(&custom));
        assert!(!is_ready(&dir.path().join("missing.bin")));
    }

    #[tokio::test]
    #[ignore]
    async fn resumes_a_partial_download() {
        let model = find("tiny").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("tiny.bin");
        let client = reqwest::Client::new();

        let head = client
            .get(model.url())
            .header(reqwest::header::RANGE, "bytes=0-10485759")
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        std::fs::write(target.with_extension("part"), head.bytes().await.unwrap()).unwrap();

        let mut reports = Vec::new();
        fetch(&client, model, &target, |progress| reports.push(progress))
            .await
            .unwrap();
        assert!(is_ready(&target));
        assert!(!target.with_extension("part").exists());
        assert!(
            reports
                .first()
                .is_some_and(|first| *first > 13.0 && *first < 14.0)
        );
        assert!(reports.windows(2).all(|pair| pair[0] <= pair[1]));

        std::fs::write(target.with_extension("part"), vec![0u8; 1 << 20]).unwrap();
        std::fs::remove_file(&target).unwrap();
        let corrupt = fetch(&client, model, &target, |_| {}).await;
        assert!(corrupt.is_err());
        assert!(!target.exists());
        assert!(!target.with_extension("part").exists());
    }
}
