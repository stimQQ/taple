use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream, unix::OwnedWriteHalf},
    sync::{Mutex, Notify, oneshot},
};
use tracing::*;

use crate::{editor_window::EditorInstances, windows::ShowCapWindow};

const CATALOG_JSON: &str = include_str!("../mcp-catalog.json");
const SOCKET_NAME: &str = "mcp.sock";
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
const TOOL_TIMEOUT: Duration = Duration::from_secs(900);
const OPEN_TIMEOUT: Duration = Duration::from_secs(60);
const RECORDING_EXTENSIONS: [&str; 3] = ["taple", "sparkvideo", "cap"];

#[derive(Deserialize)]
struct Catalog {
    instructions: String,
    tools: Vec<Value>,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(CATALOG_JSON).unwrap_or(Catalog {
        instructions: String::new(),
        tools: Vec::new(),
    })
});

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCall {
    pub request_id: String,
    pub project_path: String,
    pub client: String,
    pub name: String,
    pub arguments_json: String,
}

#[derive(Default)]
pub struct McpState {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    ready: Mutex<HashMap<PathBuf, String>>,
    ready_changed: Notify,
    current: Mutex<Option<PathBuf>>,
}

pub fn socket_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(SOCKET_NAME))
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn start(app: AppHandle) {
    app.manage(McpState::default());
    tokio::spawn(async move {
        if let Err(e) = serve(app).await {
            error!("MCP server stopped: {e}");
        }
    });
}

async fn serve(app: AppHandle) -> Result<(), String> {
    let path = socket_path(&app).ok_or("No app data directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    info!("MCP server listening on {}", path.display());

    loop {
        let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        tokio::spawn(handle_session(app.clone(), stream));
    }
}

async fn handle_session(app: AppHandle, stream: UnixStream) {
    let (read, write) = stream.into_split();
    let writer = Arc::new(Mutex::new(write));
    let client = Arc::new(Mutex::new(String::from("AI agent")));
    let mut lines = BufReader::new(read).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(e) => {
                send(
                    &writer,
                    json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}),
                )
                .await;
                continue;
            }
        };

        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        let app = app.clone();
        let writer = writer.clone();
        let client = client.clone();
        tokio::spawn(async move {
            let response = match handle_request(&app, &client, &method, &params).await {
                Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Err((code, message)) => {
                    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
                }
            };
            send(&writer, response).await;
        });
    }
}

async fn send(writer: &Mutex<OwnedWriteHalf>, message: Value) {
    let mut line = message.to_string();
    line.push('\n');
    let mut writer = writer.lock().await;
    if writer.write_all(line.as_bytes()).await.is_ok() {
        writer.flush().await.ok();
    }
}

async fn handle_request(
    app: &AppHandle,
    client: &Mutex<String>,
    method: &str,
    params: &Value,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            if let Some(name) = params
                .pointer("/clientInfo/title")
                .or_else(|| params.pointer("/clientInfo/name"))
                .and_then(Value::as_str)
            {
                *client.lock().await = name.to_string();
            }
            Ok(json!({
                "protocolVersion": params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(DEFAULT_PROTOCOL_VERSION),
                "capabilities": {
                    "tools": {"listChanged": false},
                    "prompts": {"listChanged": false}
                },
                "serverInfo": {
                    "name": "taple",
                    "title": "Taple",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": CATALOG.instructions
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let mut tools = app_tools();
            tools.extend(CATALOG.tools.iter().cloned());
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            let client = client.lock().await.clone();
            Ok(call_tool(app, &client, name, arguments).await)
        }
        "prompts/list" => Ok(json!({ "prompts": [edit_prompt_definition()] })),
        "prompts/get" => edit_prompt(params),
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn app_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "list_recordings",
            "description": "List the most recent Taple recordings on this Mac with their names, dates and paths, newest first. Shows which ones are open in the editor.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "How many recordings to list (default 10, at most 50)."}
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "open_recording",
            "description": "Open a recording in the Taple editor and make it the target of all editing tools. Pass \"latest\" for the most recent recording, or a path or name from list_recordings.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "recording": {"type": "string", "description": "\"latest\", a recording path, or a recording name."}
                },
                "required": ["recording"],
                "additionalProperties": false
            }
        }),
    ]
}

fn edit_prompt_definition() -> Value {
    json!({
        "name": "edit_recording",
        "title": "Edit a Taple recording",
        "description": "Clean up the audio, tighten the pacing, remove filler words and add zooms to a Taple recording.",
        "arguments": [
            {"name": "request", "description": "What to change. Leave empty for the default tight edit of the latest recording.", "required": false}
        ]
    })
}

fn edit_prompt(params: &Value) -> Result<Value, (i64, String)> {
    if params.get("name").and_then(Value::as_str) != Some("edit_recording") {
        return Err((-32602, "Unknown prompt".to_string()));
    }
    let request = params
        .pointer("/arguments/request")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|request| !request.is_empty())
        .unwrap_or("Tighten my latest recording: clean up the audio, remove pauses, filler words and retakes without cutting anything that happens on screen, and zoom in where small UI details matter.");
    Ok(json!({
        "description": "Edit a Taple recording",
        "messages": [{
            "role": "user",
            "content": {"type": "text", "text": format!("Use the Taple tools to edit a screen recording. {request}")}
        }]
    }))
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": text.into()}],
        "isError": is_error
    })
}

async fn call_tool(app: &AppHandle, client: &str, name: &str, arguments: Value) -> Value {
    let result = match name {
        "list_recordings" => list_recordings(app, &arguments).await,
        "open_recording" => open_recording(app, &arguments).await,
        _ if CATALOG
            .tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name)) =>
        {
            return call_editor_tool(app, client, name, arguments).await;
        }
        _ => Err(format!("Unknown tool: {name}")),
    };

    match result {
        Ok(text) => text_result(text, false),
        Err(error) => text_result(error, true),
    }
}

fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("recordings"))
        .map_err(|e| e.to_string())
}

struct RecordingEntry {
    path: PathBuf,
    name: String,
    modified: SystemTime,
}

fn recording_entries(app: &AppHandle) -> Result<Vec<RecordingEntry>, String> {
    let dir = recordings_dir(app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut recordings: Vec<RecordingEntry> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| RECORDING_EXTENSIONS.contains(&extension))
        })
        .filter_map(|path| {
            let meta = cap_project::RecordingMeta::load_for_project(&path).ok()?;
            let modified = std::fs::metadata(path.join("recording-meta.json"))
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            Some(RecordingEntry {
                name: meta.pretty_name.clone(),
                path,
                modified,
            })
        })
        .collect();

    recordings.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(recordings)
}

async fn open_projects(app: &AppHandle) -> Vec<PathBuf> {
    match app.try_state::<EditorInstances>() {
        Some(instances) => instances
            .project_paths()
            .await
            .iter()
            .map(|path| canonical(path))
            .collect(),
        None => Vec::new(),
    }
}

async fn list_recordings(app: &AppHandle, arguments: &Value) -> Result<String, String> {
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 50) as usize;
    let recordings = recording_entries(app)?;
    if recordings.is_empty() {
        return Ok("There are no Taple recordings yet.".to_string());
    }

    let open = open_projects(app).await;
    let lines: Vec<String> = recordings
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, recording)| {
            let state = if open.contains(&canonical(&recording.path)) {
                " (open in the editor)"
            } else {
                ""
            };
            format!(
                "{}. {}{}\n   path: {}",
                index + 1,
                recording.name,
                state,
                recording.path.display()
            )
        })
        .collect();

    Ok(format!(
        "{} recording(s), newest first:\n{}",
        recordings.len(),
        lines.join("\n")
    ))
}

fn resolve_recording(app: &AppHandle, query: &str) -> Result<RecordingEntry, String> {
    let query = query.trim();
    let recordings = recording_entries(app)?;

    if query.is_empty() || query.eq_ignore_ascii_case("latest") {
        return recordings
            .into_iter()
            .next()
            .ok_or_else(|| "There are no Taple recordings yet.".to_string());
    }

    let as_path = PathBuf::from(query);
    if as_path.is_dir() {
        let name = cap_project::RecordingMeta::load_for_project(&as_path)
            .map(|meta| meta.pretty_name.clone())
            .unwrap_or_else(|_| query.to_string());
        return Ok(RecordingEntry {
            path: as_path,
            name,
            modified: SystemTime::UNIX_EPOCH,
        });
    }

    recordings
        .into_iter()
        .find(|recording| recording.name == query || recording.name.contains(query))
        .ok_or_else(|| {
            format!("No recording matches \"{query}\". Call list_recordings to see the names.")
        })
}

async fn wait_until_ready(app: &AppHandle, path: &Path) -> bool {
    let Some(state) = app.try_state::<McpState>() else {
        return false;
    };
    let deadline = tokio::time::Instant::now() + OPEN_TIMEOUT;
    loop {
        let notified = state.ready_changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if state.ready.lock().await.contains_key(path) {
            return true;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return false;
        }
    }
}

async fn open_recording(app: &AppHandle, arguments: &Value) -> Result<String, String> {
    let query = arguments
        .get("recording")
        .and_then(Value::as_str)
        .unwrap_or("latest");
    let recording = resolve_recording(app, query)?;
    let path = canonical(&recording.path);

    ShowCapWindow::Editor {
        project_path: recording.path.clone(),
    }
    .show(app)
    .await
    .map_err(|e| format!("Could not open the editor: {e}"))?;

    if !wait_until_ready(app, &path).await {
        return Err(
            "The Taple editor did not finish loading this recording. Try open_recording again."
                .to_string(),
        );
    }

    if let Some(state) = app.try_state::<McpState>() {
        *state.current.lock().await = Some(path.clone());
    }

    Ok(format!(
        "Opened \"{}\" in the Taple editor. All editing tools now work on it. Next: prepare_audio, then get_overview.",
        recording.name
    ))
}

async fn target_project(app: &AppHandle) -> Result<String, String> {
    let state = app.try_state::<McpState>().ok_or("MCP is not running")?;
    let open = open_projects(app).await;
    let ready = state.ready.lock().await.clone();

    if let Some(current) = state.current.lock().await.clone()
        && open.contains(&current)
        && let Some(original) = ready.get(&current)
    {
        return Ok(original.clone());
    }

    let candidates: Vec<String> = open
        .iter()
        .filter_map(|path| ready.get(path).cloned())
        .collect();
    match candidates.as_slice() {
        [only] => Ok(only.clone()),
        [] => Err(
            "No recording is open in the Taple editor. Call list_recordings and open_recording first."
                .to_string(),
        ),
        _ => Err(
            "Several recordings are open. Call open_recording to choose which one to edit."
                .to_string(),
        ),
    }
}

async fn call_editor_tool(app: &AppHandle, client: &str, name: &str, arguments: Value) -> Value {
    let project = match target_project(app).await {
        Ok(project) => project,
        Err(error) => return text_result(error, true),
    };
    let Some(state) = app.try_state::<McpState>() else {
        return text_result("MCP is not running", true);
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .await
        .insert(request_id.clone(), sender);

    let event = McpToolCall {
        request_id: request_id.clone(),
        project_path: project,
        client: client.to_string(),
        name: name.to_string(),
        arguments_json: arguments.to_string(),
    };
    if let Err(e) = event.emit(app) {
        state.pending.lock().await.remove(&request_id);
        return text_result(format!("Could not reach the Taple editor: {e}"), true);
    }

    match tokio::time::timeout(TOOL_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => text_result("The Taple editor closed before the tool finished.", true),
        Err(_) => {
            state.pending.lock().await.remove(&request_id);
            text_result("The Taple editor did not answer in time.", true)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_tool_result(
    app: AppHandle,
    request_id: String,
    result_json: String,
) -> Result<(), String> {
    let state = app.try_state::<McpState>().ok_or("MCP is not running")?;
    let result: Value = serde_json::from_str(&result_json).map_err(|e| e.to_string())?;
    if let Some(sender) = state.pending.lock().await.remove(&request_id) {
        sender.send(result).ok();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_editor_ready(app: AppHandle, project_path: String) -> Result<(), String> {
    let state = app.try_state::<McpState>().ok_or("MCP is not running")?;
    state
        .ready
        .lock()
        .await
        .insert(canonical(Path::new(&project_path)), project_path);
    state.ready_changed.notify_waiters();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_editor_closed(app: AppHandle, project_path: String) -> Result<(), String> {
    let state = app.try_state::<McpState>().ok_or("MCP is not running")?;
    state
        .ready
        .lock()
        .await
        .remove(&canonical(Path::new(&project_path)));
    state.ready_changed.notify_waiters();
    Ok(())
}
