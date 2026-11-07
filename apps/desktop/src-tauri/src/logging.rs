use crate::ArcLock;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const LOG_FILE_PREFIX: &str = "taple-desktop.log";
const LOG_TAIL_BYTES: usize = 512 * 1024;

async fn latest_log_file(app: &AppHandle) -> Option<PathBuf> {
    let logs_dir = app
        .state::<ArcLock<crate::App>>()
        .read()
        .await
        .logs_dir
        .clone();

    fs::read_dir(&logs_dir)
        .ok()?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let is_log = path.is_file() && path.file_name()?.to_str()?.starts_with(LOG_FILE_PREFIX);
            is_log.then_some(())?;
            Some((fs::metadata(&path).ok()?.modified().ok()?, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

pub async fn recent_log(app: &AppHandle) -> Option<String> {
    let bytes = fs::read(latest_log_file(app).await?).ok()?;
    let log = log_tail(&bytes, LOG_TAIL_BYTES, dirs::home_dir().as_deref());
    (!log.trim().is_empty()).then_some(log)
}

fn log_tail(bytes: &[u8], limit: usize, home: Option<&Path>) -> String {
    let start = bytes.len().saturating_sub(limit);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let text = if start > 0 {
        text.split_once('\n').map_or(&*text, |(_, rest)| rest)
    } else {
        &text
    };
    match home.and_then(Path::to_str).filter(|home| home.len() > 1) {
        Some(home) => text.replace(home, "~"),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_whole_lines_and_hides_the_home_folder() {
        let log = b"first line\nsecond /Users/alex/Movies/a.mov\nthird /Users/alex\n";
        let home = Path::new("/Users/alex");

        assert_eq!(
            log_tail(log, log.len(), Some(home)),
            "first line\nsecond ~/Movies/a.mov\nthird ~\n"
        );
        assert_eq!(
            log_tail(log, 30, Some(home)),
            "third ~\n",
            "a cut-off first line is dropped"
        );
        assert_eq!(log_tail(log, 4, None), "");
    }
}
