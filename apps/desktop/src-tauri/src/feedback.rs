use crate::{http_client::HttpClient, logging};
use reqwest::{StatusCode, header::USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{process::Command, time::Duration};
use tauri::{AppHandle, Manager};
use tracing::warn;

const SITE_URL: &str = "https://taple.app";
const SITE_URL_ENV: &str = "TAPLE_SITE_URL";
const MAX_MESSAGE_CHARS: usize = 5000;
const MAX_EMAIL_LEN: usize = 254;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Type, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub app_version: String,
    pub os_version: String,
    pub chip: String,
    pub model: String,
    pub locale: String,
}

#[derive(Deserialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackInput {
    pub message: String,
    pub email: Option<String>,
    pub include_diagnostics: bool,
    pub include_log: bool,
}

#[derive(Serialize, Type, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackError {
    Invalid,
    RateLimited,
    Unavailable,
    Network,
}

pub fn site_url(path: &str) -> String {
    let base = std::env::var(SITE_URL_ENV).unwrap_or_else(|_| SITE_URL.to_string());
    format!("{}{path}", base.trim_end_matches('/'))
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn collect_diagnostics(app_version: String) -> SystemDiagnostics {
    let unknown = || "unknown".to_string();
    let arch = std::env::consts::ARCH;
    let os_version = match (
        command_output("/usr/bin/sw_vers", &["-productVersion"]),
        command_output("/usr/bin/sw_vers", &["-buildVersion"]),
    ) {
        (Some(version), Some(build)) => format!("macOS {version} ({build})"),
        (Some(version), None) => format!("macOS {version}"),
        _ => unknown(),
    };

    SystemDiagnostics {
        app_version,
        os_version,
        chip: command_output("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"])
            .map_or_else(|| arch.to_string(), |chip| format!("{chip} ({arch})")),
        model: command_output("/usr/sbin/sysctl", &["-n", "hw.model"]).unwrap_or_else(unknown),
        locale: command_output("/usr/bin/defaults", &["read", "-g", "AppleLocale"])
            .unwrap_or_else(unknown),
    }
}

async fn diagnostics(app: &AppHandle) -> SystemDiagnostics {
    let app_version = app.package_info().version.to_string();
    let fallback = app_version.clone();
    tokio::task::spawn_blocking(move || collect_diagnostics(app_version))
        .await
        .unwrap_or_else(|_| collect_diagnostics(fallback))
}

fn is_valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= MAX_EMAIL_LEN
        && !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.chars().any(char::is_whitespace)
}

fn validate(input: &FeedbackInput) -> Result<(&str, Option<&str>), FeedbackError> {
    let message = input.message.trim();
    if message.is_empty() || message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(FeedbackError::Invalid);
    }
    let email = input
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty());
    if email.is_some_and(|email| !is_valid_email(email)) {
        return Err(FeedbackError::Invalid);
    }
    Ok((message, email))
}

fn error_for_status(status: StatusCode) -> FeedbackError {
    match status {
        StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE => FeedbackError::Invalid,
        StatusCode::TOO_MANY_REQUESTS => FeedbackError::RateLimited,
        _ => FeedbackError::Unavailable,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn system_diagnostics(app: AppHandle) -> SystemDiagnostics {
    diagnostics(&app).await
}

#[tauri::command]
#[specta::specta]
pub async fn send_feedback(app: AppHandle, input: FeedbackInput) -> Result<(), FeedbackError> {
    let (message, email) = validate(&input)?;
    let version = app.package_info().version.to_string();
    let diagnostics = if input.include_diagnostics {
        Some(diagnostics(&app).await)
    } else {
        None
    };
    let log = if input.include_log {
        logging::recent_log(&app).await
    } else {
        None
    };

    let client = reqwest::Client::clone(&app.state::<HttpClient>());
    let response = client
        .post(site_url("/api/feedback"))
        .timeout(REQUEST_TIMEOUT)
        .header(USER_AGENT, format!("Taple/{version}"))
        .header("X-Taple-Version", &version)
        .json(&json!({
            "message": message,
            "email": email,
            "diagnostics": diagnostics,
            "log": log,
        }))
        .send()
        .await
        .map_err(|error| {
            warn!("Sending feedback failed: {error}");
            FeedbackError::Network
        })?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    warn!("Feedback service answered {status}");
    Err(error_for_status(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(message: &str, email: Option<&str>) -> FeedbackInput {
        FeedbackInput {
            message: message.to_string(),
            email: email.map(str::to_string),
            include_diagnostics: false,
            include_log: false,
        }
    }

    #[test]
    fn validates_message_and_email() {
        assert_eq!(
            validate(&input("  Export froze  ", Some("  "))),
            Ok(("Export froze", None))
        );
        assert_eq!(
            validate(&input("Hi", Some("me@example.com"))),
            Ok(("Hi", Some("me@example.com")))
        );
        assert_eq!(validate(&input("   ", None)), Err(FeedbackError::Invalid));
        assert_eq!(
            validate(&input(&"字".repeat(MAX_MESSAGE_CHARS + 1), None)),
            Err(FeedbackError::Invalid)
        );
        assert!(validate(&input(&"字".repeat(MAX_MESSAGE_CHARS), None)).is_ok());
        for email in [
            "me",
            "me@",
            "@example.com",
            "me@example",
            "a b@example.com",
            "me@.com",
        ] {
            assert_eq!(
                validate(&input("Hi", Some(email))),
                Err(FeedbackError::Invalid),
                "{email}"
            );
        }
    }

    #[test]
    fn maps_service_errors() {
        assert_eq!(
            error_for_status(StatusCode::TOO_MANY_REQUESTS),
            FeedbackError::RateLimited
        );
        assert_eq!(
            error_for_status(StatusCode::BAD_REQUEST),
            FeedbackError::Invalid
        );
        assert_eq!(
            error_for_status(StatusCode::BAD_GATEWAY),
            FeedbackError::Unavailable
        );
        assert_eq!(
            error_for_status(StatusCode::NOT_FOUND),
            FeedbackError::Unavailable
        );
    }
}
