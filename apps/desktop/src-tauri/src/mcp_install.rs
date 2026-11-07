use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::AppHandle;

use crate::{i18n::tr, mcp::socket_path, mcp_bridge::MCP_FLAG};

const SERVER_NAME: &str = "taple";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum McpClient {
    ClaudeCode,
    Codex,
    ClaudeDesktop,
    Cursor,
}

const CLIENTS: [McpClient; 4] = [
    McpClient::ClaudeCode,
    McpClient::Codex,
    McpClient::ClaudeDesktop,
    McpClient::Cursor,
];

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    pub client: McpClient,
    pub available: bool,
    pub connected: bool,
    pub needs_update: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct ServerEntry {
    command: String,
    args: Vec<String>,
}

fn server_entry(app: &AppHandle) -> Result<ServerEntry, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let socket = socket_path(app).ok_or("No app data directory")?;
    Ok(ServerEntry {
        command: exe.to_string_lossy().into_owned(),
        args: vec![
            MCP_FLAG.to_string(),
            "--socket".to_string(),
            socket.to_string_lossy().into_owned(),
        ],
    })
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "No home directory".to_string())
}

fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        Command::new("/bin/zsh")
            .args(["-lc", "printf %s \"$PATH\""])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
    })
}

fn find_cli(name: &str) -> Option<PathBuf> {
    let home = dirs::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join(".claude/local").join(name));
        candidates.push(home.join(".npm-global/bin").join(name));
        candidates.push(home.join(".bun/bin").join(name));
        candidates.push(home.join(".volta/bin").join(name));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(name));
    candidates.push(PathBuf::from("/usr/local/bin").join(name));
    for dir in login_path().split(':').filter(|dir| !dir.is_empty()) {
        candidates.push(PathBuf::from(dir).join(name));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn claude_code_config() -> Result<PathBuf, String> {
    Ok(home()?.join(".claude.json"))
}

fn codex_config() -> Result<PathBuf, String> {
    let dir = match std::env::var("CODEX_HOME") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => home()?.join(".codex"),
    };
    Ok(dir.join("config.toml"))
}

fn claude_desktop_config() -> Result<PathBuf, String> {
    Ok(home()?.join("Library/Application Support/Claude/claude_desktop_config.json"))
}

fn cursor_config() -> Result<PathBuf, String> {
    Ok(home()?.join(".cursor/mcp.json"))
}

fn backup(path: &Path) {
    if path.exists() {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".taple-backup");
        std::fs::copy(path, path.with_file_name(name)).ok();
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn json_server(path: &Path) -> Option<ServerEntry> {
    let root = read_json(path).ok()?;
    let server = root.get("mcpServers")?.get(SERVER_NAME)?;
    Some(ServerEntry {
        command: server.get("command")?.as_str()?.to_string(),
        args: server
            .get("args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(|arg| arg.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn write_json_server(
    path: &Path,
    entry: Option<&ServerEntry>,
    stdio_type: bool,
) -> Result<(), String> {
    let mut root = read_json(path)?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("mcpServers in {} is not an object", path.display()))?;

    match entry {
        Some(entry) => {
            let mut server = json!({ "command": entry.command, "args": entry.args });
            if stdio_type {
                server["type"] = json!("stdio");
                server["env"] = json!({});
            }
            servers.insert(SERVER_NAME.to_string(), server);
        }
        None => {
            servers.remove(SERVER_NAME);
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup(path);
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(path, format!("{text}\n")).map_err(|e| e.to_string())
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn is_server_header(line: &str) -> Option<bool> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let header = trimmed
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim()
        .replace('"', "");
    let own = format!("mcp_servers.{SERVER_NAME}");
    Some(header == own || header.starts_with(&format!("{own}.")))
}

fn remove_toml_server(text: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in text.lines() {
        if let Some(own) = is_server_header(line) {
            skipping = own;
        }
        if !skipping {
            kept.push(line);
        }
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    if kept.is_empty() {
        String::new()
    } else {
        format!("{}\n", kept.join("\n"))
    }
}

fn add_toml_server(text: &str, entry: &ServerEntry) -> String {
    let base = remove_toml_server(text);
    let args = entry
        .args
        .iter()
        .map(|arg| toml_string(arg))
        .collect::<Vec<_>>()
        .join(", ");
    let block = format!(
        "[mcp_servers.{SERVER_NAME}]\ncommand = {}\nargs = [{args}]\nstartup_timeout_sec = 60\ntool_timeout_sec = 900\n",
        toml_string(&entry.command)
    );
    if base.is_empty() {
        block
    } else {
        format!("{base}\n{block}")
    }
}

fn toml_server_command(text: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        if let Some(own) = is_server_header(line) {
            inside = own
                && line.trim().trim_matches(['[', ']']).replace('"', "")
                    == format!("mcp_servers.{SERVER_NAME}");
            continue;
        }
        if inside {
            let trimmed = line.trim();
            if let Some(value) = trimmed.strip_prefix("command") {
                let value = value.trim().strip_prefix('=')?.trim();
                return Some(
                    value
                        .trim_matches('"')
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\"),
                );
            }
        }
    }
    None
}

fn write_codex(entry: Option<&ServerEntry>) -> Result<(), String> {
    let path = codex_config()?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = match entry {
        Some(entry) => add_toml_server(&text, entry),
        None => remove_toml_server(&text),
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    backup(&path);
    std::fs::write(&path, updated).map_err(|e| e.to_string())
}

fn run_claude(cli: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new(cli)
        .args(args)
        .env("PATH", login_path())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!("{} {}", stderr.trim(), stdout.trim())
        .trim()
        .to_string())
}

fn connect_claude_code(entry: Option<&ServerEntry>) -> Result<(), String> {
    if let Some(cli) = find_cli("claude") {
        let configured = json_server(&claude_code_config()?).is_some();
        if configured {
            run_claude(&cli, &["mcp", "remove", "--scope", "user", SERVER_NAME])?;
        }
        if let Some(entry) = entry {
            let config = json!({
                "type": "stdio",
                "command": entry.command,
                "args": entry.args,
                "env": {}
            })
            .to_string();
            run_claude(
                &cli,
                &["mcp", "add-json", "--scope", "user", SERVER_NAME, &config],
            )?;
        }
        return Ok(());
    }
    write_json_server(&claude_code_config()?, entry, true)
}

fn available(client: McpClient) -> Result<bool, String> {
    let home = home()?;
    Ok(match client {
        McpClient::ClaudeCode => {
            find_cli("claude").is_some()
                || home.join(".claude").is_dir()
                || claude_code_config()?.exists()
        }
        McpClient::Codex => {
            find_cli("codex").is_some()
                || codex_config()?.parent().is_some_and(Path::is_dir)
                || Path::new("/Applications/Codex.app").exists()
        }
        McpClient::ClaudeDesktop => {
            Path::new("/Applications/Claude.app").exists()
                || claude_desktop_config()?.parent().is_some_and(Path::is_dir)
        }
        McpClient::Cursor => {
            Path::new("/Applications/Cursor.app").exists() || home.join(".cursor").is_dir()
        }
    })
}

fn configured_command(client: McpClient) -> Result<Option<String>, String> {
    Ok(match client {
        McpClient::ClaudeCode => json_server(&claude_code_config()?).map(|entry| entry.command),
        McpClient::Codex => std::fs::read_to_string(codex_config()?)
            .ok()
            .and_then(|text| toml_server_command(&text)),
        McpClient::ClaudeDesktop => {
            json_server(&claude_desktop_config()?).map(|entry| entry.command)
        }
        McpClient::Cursor => json_server(&cursor_config()?).map(|entry| entry.command),
    })
}

fn apply(client: McpClient, entry: Option<&ServerEntry>) -> Result<(), String> {
    match client {
        McpClient::ClaudeCode => connect_claude_code(entry),
        McpClient::Codex => write_codex(entry),
        McpClient::ClaudeDesktop => write_json_server(&claude_desktop_config()?, entry, false),
        McpClient::Cursor => write_json_server(&cursor_config()?, entry, false),
    }
}

fn failed(error: String) -> String {
    format!(
        "{}: {error}",
        tr("更新智能体配置失败", "Failed to update the agent settings")
    )
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_client_statuses(app: AppHandle) -> Result<Vec<McpClientStatus>, String> {
    let entry = server_entry(&app)?;
    tokio::task::spawn_blocking(move || {
        CLIENTS
            .iter()
            .map(|client| {
                let command = configured_command(*client)?;
                Ok(McpClientStatus {
                    client: *client,
                    available: available(*client)?,
                    connected: command.is_some(),
                    needs_update: command.is_some_and(|command| command != entry.command),
                })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_connect_client(app: AppHandle, client: McpClient) -> Result<(), String> {
    let entry = server_entry(&app)?;
    tokio::task::spawn_blocking(move || apply(client, Some(&entry)).map_err(failed))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_disconnect_client(client: McpClient) -> Result<(), String> {
    tokio::task::spawn_blocking(move || apply(client, None).map_err(failed))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        ServerEntry, add_toml_server, json_server, remove_toml_server, toml_server_command,
        write_json_server,
    };

    fn entry() -> ServerEntry {
        ServerEntry {
            command: "/Applications/Taple.app/Contents/MacOS/Taple".to_string(),
            args: vec![
                "--mcp".to_string(),
                "--socket".to_string(),
                "/Users/me/Library/Application Support/app.taple.desktop/mcp.sock".to_string(),
            ],
        }
    }

    #[test]
    fn adds_and_replaces_the_codex_server_block() {
        let original = "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n\n[mcp_servers.taple]\ncommand = \"/old/Taple\"\nargs = []\n\n[mcp_servers.taple.env]\nA = \"1\"\n\n[profiles.fast]\nmodel = \"x\"\n";
        let updated = add_toml_server(original, &entry());
        assert!(updated.starts_with("model = \"gpt-5\"\n"));
        assert!(updated.contains("[mcp_servers.other]\ncommand = \"other\""));
        assert!(updated.contains("[profiles.fast]\nmodel = \"x\""));
        assert!(!updated.contains("/old/Taple"));
        assert!(!updated.contains("[mcp_servers.taple.env]"));
        assert_eq!(updated.matches("[mcp_servers.taple]").count(), 1);
        assert_eq!(
            toml_server_command(&updated).as_deref(),
            Some("/Applications/Taple.app/Contents/MacOS/Taple")
        );
        assert!(updated.contains("Application Support/app.taple.desktop/mcp.sock"));

        let removed = remove_toml_server(&updated);
        assert!(!removed.contains("taple"));
        assert!(removed.contains("[profiles.fast]"));
    }

    #[test]
    fn writes_json_servers_without_touching_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"other":{"command":"x"}},"theme":"dark"}"#,
        )
        .unwrap();

        write_json_server(&path, Some(&entry()), false).unwrap();
        assert_eq!(json_server(&path), Some(entry()));
        let root: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(root["theme"], "dark");
        assert_eq!(root["mcpServers"]["other"]["command"], "x");
        assert!(dir.path().join("mcp.json.taple-backup").exists());

        write_json_server(&path, None, false).unwrap();
        assert_eq!(json_server(&path), None);
    }
}
