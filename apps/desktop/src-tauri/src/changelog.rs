use crate::{feedback::site_url, http_client::HttpClient};
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tracing::warn;

const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/stimQQ/taple/releases?per_page=20";
const CACHE_TTL: Duration = Duration::from_secs(600);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

static CACHE: Mutex<Option<(Instant, Vec<ReleaseNote>)>> = Mutex::new(None);

#[derive(Serialize, Type, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub title: String,
    pub published_at: Option<String>,
    pub body_html: String,
    pub url: String,
    pub prerelease: bool,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    published_at: Option<String>,
    body_html: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
}

fn release_note(release: GithubRelease) -> Option<ReleaseNote> {
    if release.draft {
        return None;
    }
    let version = release.tag_name.trim().trim_start_matches('v').to_string();
    let title = release
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| {
            !name.is_empty() && name.trim_start_matches('v') != version && *name != release.tag_name
        })
        .unwrap_or_default();
    Some(ReleaseNote {
        version,
        title,
        published_at: release.published_at,
        body_html: release.body_html.unwrap_or_default(),
        url: release.html_url,
        prerelease: release.prerelease,
    })
}

async fn fetch_releases(
    client: &reqwest::Client,
    url: &str,
    user_agent: &str,
) -> Result<Vec<GithubRelease>, String> {
    client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .header(USER_AGENT, user_agent)
        .header(ACCEPT, "application/vnd.github.html+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())
}

fn cached() -> Option<Vec<ReleaseNote>> {
    let cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache
        .as_ref()
        .filter(|(fetched_at, _)| fetched_at.elapsed() < CACHE_TTL)
        .map(|(_, notes)| notes.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn list_release_notes(app: AppHandle) -> Result<Vec<ReleaseNote>, String> {
    if let Some(notes) = cached() {
        return Ok(notes);
    }

    let user_agent = format!("Taple/{}", app.package_info().version);
    let client = reqwest::Client::clone(&app.state::<HttpClient>());
    let mut errors = Vec::new();
    let mut releases = None;
    for url in [site_url("/api/releases"), GITHUB_RELEASES_API.to_string()] {
        match fetch_releases(&client, &url, &user_agent).await {
            Ok(list) => {
                releases = Some(list);
                break;
            }
            Err(error) => {
                warn!("Loading release notes from {url} failed: {error}");
                errors.push(error);
            }
        }
    }
    let releases = releases.ok_or_else(|| errors.join("; "))?;

    let notes: Vec<ReleaseNote> = releases.into_iter().filter_map(release_note).collect();
    *CACHE.lock().unwrap_or_else(|error| error.into_inner()) =
        Some((Instant::now(), notes.clone()));
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, name: Option<&str>, draft: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            name: name.map(str::to_string),
            published_at: Some("2026-11-08T10:00:00Z".to_string()),
            body_html: Some("<ul><li>First release</li></ul>".to_string()),
            html_url: format!("https://github.com/stimQQ/taple/releases/tag/{tag}"),
            draft,
            prerelease: false,
        }
    }

    #[test]
    fn turns_github_releases_into_notes() {
        let note = release_note(release("v0.1.0", Some("Taple 0.1"), false)).unwrap();
        assert_eq!(note.version, "0.1.0");
        assert_eq!(note.title, "Taple 0.1");
        assert_eq!(note.body_html, "<ul><li>First release</li></ul>");

        for name in [Some("v0.1.0"), Some("0.1.0"), Some("  "), None] {
            assert_eq!(
                release_note(release("v0.1.0", name, false)).unwrap().title,
                "",
                "{name:?}"
            );
        }
        assert!(release_note(release("v0.2.0", None, true)).is_none());
    }

    #[test]
    fn reads_the_github_response_shape() {
        let json = r#"[{"tag_name":"v0.1.0","name":"Taple 0.1","published_at":"2026-11-08T10:00:00Z","body_html":"<p>Hi</p>","html_url":"https://github.com/stimQQ/taple/releases/tag/v0.1.0","draft":false,"prerelease":false,"assets":[]}]"#;
        let releases: Vec<GithubRelease> = serde_json::from_str(json).unwrap();
        let notes: Vec<_> = releases.into_iter().filter_map(release_note).collect();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body_html, "<p>Hi</p>");
    }
}
