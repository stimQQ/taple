use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

pub const MCP_FLAG: &str = "--mcp";
const SOCKET_FLAG: &str = "--socket";
const LAUNCH_WAIT: Duration = Duration::from_secs(45);
const RETRY_INTERVAL: Duration = Duration::from_millis(300);

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

async fn pipe(stream: UnixStream) {
    let (mut socket_read, mut socket_write) = stream.into_split();

    let upstream = async move {
        let mut stdin = tokio::io::stdin();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if socket_write.write_all(&buffer[..read]).await.is_err() {
                        break;
                    }
                }
            }
        }
        socket_write.shutdown().await.ok();
    };

    let downstream = async move {
        let mut stdout = tokio::io::stdout();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match socket_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if stdout.write_all(&buffer[..read]).await.is_err() {
                        break;
                    }
                    stdout.flush().await.ok();
                }
            }
        }
    };

    tokio::join!(upstream, downstream);
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

    let code = runtime.block_on(async {
        match connect(&socket).await {
            Ok(stream) => {
                pipe(stream).await;
                0
            }
            Err(message) => {
                eprintln!("{message}");
                1
            }
        }
    });

    std::process::exit(code);
}
