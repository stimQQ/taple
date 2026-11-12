use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{
        UnixStream,
        unix::{OwnedReadHalf, OwnedWriteHalf},
    },
    sync::{Mutex, mpsc},
};

pub const MCP_FLAG: &str = "--mcp";
const SOCKET_FLAG: &str = "--socket";
const LAUNCH_WAIT: Duration = Duration::from_secs(45);
const RETRY_INTERVAL: Duration = Duration::from_millis(300);
const FLUSH_WAIT: Duration = Duration::from_secs(1);
const REPLAY_ID: &str = "taple-bridge-initialize";
const QUIT_DURING_CALL: &str =
    "Taple quit before the tool finished. Call the tool again to reopen Taple.";
const UNREACHABLE: &str = "Could not reach Taple. Open Taple, then try again.";

#[derive(Default)]
struct Calls {
    closed: bool,
    pending: HashMap<String, Value>,
}

type SharedCalls = Arc<Mutex<Calls>>;

struct Connection {
    writer: OwnedWriteHalf,
    calls: SharedCalls,
}

enum Sent {
    Done,
    Retry,
}

pub fn requested() -> bool {
    std::env::args().any(|arg| arg == MCP_FLAG)
}

fn socket_from_args() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|arg| arg == SOCKET_FLAG)
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from)
}

pub fn bundle_of(exe: &Path) -> Option<&Path> {
    exe.ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
}

fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    bundle_of(&exe).map(Path::to_path_buf)
}

fn launch_app() -> bool {
    let Some(bundle) = app_bundle() else {
        return false;
    };
    std::process::Command::new("/usr/bin/open")
        .arg("-g")
        .arg(&bundle)
        .status()
        .is_ok_and(|status| status.success())
}

async fn connect(socket: &Path) -> Result<UnixStream, String> {
    if let Ok(stream) = UnixStream::connect(socket).await {
        return Ok(stream);
    }

    if !launch_app() {
        return Err("Taple is not running. Open Taple, then try again.".to_string());
    }

    let deadline = tokio::time::Instant::now() + LAUNCH_WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(RETRY_INTERVAL).await;
        if let Ok(stream) = UnixStream::connect(socket).await {
            return Ok(stream);
        }
    }

    Err("Taple did not start in time. Open Taple, then try again.".to_string())
}

fn call_key(id: &Value) -> String {
    id.to_string()
}

async fn relay_responses(
    read: OwnedReadHalf,
    out: mpsc::UnboundedSender<String>,
    calls: SharedCalls,
) {
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let id = serde_json::from_str::<Value>(&line)
            .ok()
            .and_then(|message| message.get("id").cloned());
        if let Some(id) = &id {
            if id.as_str() == Some(REPLAY_ID) {
                continue;
            }
            calls.lock().await.pending.remove(&call_key(id));
        }
        if out.send(line).is_err() {
            break;
        }
    }

    let orphaned: Vec<Value> = {
        let mut calls = calls.lock().await;
        calls.closed = true;
        calls.pending.drain().map(|(_, id)| id).collect()
    };
    for id in orphaned {
        out.send(crate::mcp::tool_error_response(id, QUIT_DURING_CALL).to_string())
            .ok();
    }
}

async fn open_connection(
    socket: &Path,
    initialize: Option<&Value>,
    out: &mpsc::UnboundedSender<String>,
) -> Result<Connection, String> {
    let stream = connect(socket).await?;
    let (read, mut writer) = stream.into_split();

    if let Some(params) = initialize {
        let mut line = json!({
            "jsonrpc": "2.0",
            "id": REPLAY_ID,
            "method": "initialize",
            "params": params
        })
        .to_string();
        line.push('\n');
        writer
            .write_all(line.as_bytes())
            .await
            .map_err(|_| UNREACHABLE.to_string())?;
    }

    let calls = SharedCalls::default();
    tokio::spawn(relay_responses(read, out.clone(), calls.clone()));

    Ok(Connection { writer, calls })
}

async fn try_send(connection: &mut Connection, key: &str, id: &Value, data: &[u8]) -> Sent {
    {
        let mut calls = connection.calls.lock().await;
        if calls.closed {
            return Sent::Retry;
        }
        calls.pending.insert(key.to_string(), id.clone());
    }

    if connection.writer.write_all(data).await.is_ok() {
        return Sent::Done;
    }

    if connection.calls.lock().await.pending.remove(key).is_some() {
        Sent::Retry
    } else {
        Sent::Done
    }
}

async fn forward_call(
    socket: &Path,
    connection: &mut Option<Connection>,
    initialize: Option<&Value>,
    out: &mpsc::UnboundedSender<String>,
    id: &Value,
    line: &str,
) -> Result<(), String> {
    let key = call_key(id);
    let mut data = line.to_string();
    data.push('\n');

    for _ in 0..2 {
        if connection.is_none() {
            *connection = Some(open_connection(socket, initialize, out).await?);
        }

        if let Some(open) = connection.as_mut()
            && matches!(try_send(open, &key, id, data.as_bytes()).await, Sent::Done)
        {
            return Ok(());
        }

        *connection = None;
    }

    Err(UNREACHABLE.to_string())
}

async fn serve(socket: PathBuf) {
    let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(mut line) = out_rx.recv().await {
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            stdout.flush().await.ok();
        }
    });

    let mut connection: Option<Connection> = None;
    let mut initialize: Option<Value> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(e) => {
                out.send(
                    json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}})
                        .to_string(),
                )
                .ok();
                continue;
            }
        };

        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        if method != "tools/call" {
            if method == "initialize" {
                initialize = Some(params.clone());
            }
            out.send(crate::mcp::local_response(id, method, &params).to_string())
                .ok();
            continue;
        }

        if let Err(error) = forward_call(
            &socket,
            &mut connection,
            initialize.as_ref(),
            &out,
            &id,
            line,
        )
        .await
        {
            out.send(crate::mcp::tool_error_response(id, &error).to_string())
                .ok();
        }
    }

    drop(connection);
    drop(out);
    tokio::time::timeout(FLUSH_WAIT, writer).await.ok();
}

pub fn run() -> ! {
    let Some(socket) = socket_from_args() else {
        eprintln!("taple --mcp needs --socket <path>");
        std::process::exit(2);
    };

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("Could not start the Taple MCP bridge: {e}");
            std::process::exit(1);
        }
    };

    runtime.block_on(serve(socket));
    std::process::exit(0);
}
