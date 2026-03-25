pub mod auth;
pub mod event_bridge;
pub mod handlers;
pub mod router;
pub mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use crate::app_error::{AppCommandError, AppErrorCode};

pub struct WebServerState {
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    port: AtomicU16,
    token: Mutex<String>,
    running: std::sync::atomic::AtomicBool,
}

impl WebServerState {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            port: AtomicU16::new(0),
            token: Mutex::new(String::new()),
            running: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerInfo {
    pub port: u16,
    pub token: String,
    pub addresses: Vec<String>,
}

fn generate_random_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

fn find_static_dir(app: &tauri::AppHandle) -> PathBuf {
    // 1. Production: Tauri bundles frontendDist into the resource directory.
    let resource = app.path().resource_dir().ok();
    if let Some(ref dir) = resource {
        // In production builds, the HTML files are at the resource root.
        if dir.join("index.html").exists() {
            eprintln!("[WEB] Serving static files from resource dir: {}", dir.display());
            return dir.clone();
        }
        // Or possibly in an "out" subdirectory.
        let out = dir.join("out");
        if out.join("index.html").exists() {
            eprintln!("[WEB] Serving static files from resource/out: {}", out.display());
            return out;
        }
    }

    // 2. Dev mode: "out/" is at the project root, which is one level above src-tauri/.
    //    The Cargo manifest dir at compile time gives us the src-tauri/ path.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_out = manifest_dir.parent().map(|p| p.join("out"));
    if let Some(ref out) = project_out {
        if out.join("index.html").exists() {
            eprintln!("[WEB] Serving static files from project out/: {}", out.display());
            return out.clone();
        }
    }

    // 3. Fallback: current working directory / out
    let cwd_out = std::env::current_dir()
        .map(|d| d.join("out"))
        .unwrap_or_else(|_| PathBuf::from("out"));
    eprintln!(
        "[WEB] Fallback static dir (may not exist): {}",
        cwd_out.display()
    );
    cwd_out
}

fn get_local_addresses(port: u16) -> Vec<String> {
    let mut addrs = vec![format!("http://127.0.0.1:{}", port)];
    // Try to get LAN IPs
    if let Ok(interfaces) = std::net::UdpSocket::bind("0.0.0.0:0") {
        // Connect to a public DNS to determine local IP
        if interfaces.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = interfaces.local_addr() {
                addrs.push(format!("http://{}:{}", local_addr.ip(), port));
            }
        }
    }
    addrs
}

#[tauri::command]
pub async fn start_web_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, WebServerState>,
    port: Option<u16>,
    host: Option<String>,
) -> Result<WebServerInfo, AppCommandError> {
    // Check if already running
    if state.running.load(Ordering::Relaxed) {
        return Err(AppCommandError::new(
            AppErrorCode::AlreadyExists,
            "Web server is already running",
        ));
    }

    let port = port.unwrap_or(3080);
    let host = host.unwrap_or_else(|| "0.0.0.0".to_string());
    let token = generate_random_token();

    // Determine static directory for serving the frontend.
    // In production: files are bundled into the resource directory.
    // In dev: the "out/" directory is at the project root (one level above src-tauri/).
    let static_dir = find_static_dir(&app);

    let router = router::build_router(app.clone(), token.clone(), static_dir);

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .map_err(|e: std::net::AddrParseError| {
            AppCommandError::invalid_input("Invalid host/port").with_detail(e.to_string())
        })?;

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| {
        AppCommandError::io_error("Failed to bind address").with_detail(e.to_string())
    })?;

    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    eprintln!("[WEB] Starting web server on {}", addr);

    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[WEB] Server error: {}", e);
        }
    });

    // Store state
    *state.handle.lock().unwrap() = Some(handle);
    state.port.store(actual_port, Ordering::Relaxed);
    *state.token.lock().unwrap() = token.clone();
    state.running.store(true, Ordering::Relaxed);

    let addresses = get_local_addresses(actual_port);

    Ok(WebServerInfo {
        port: actual_port,
        token,
        addresses,
    })
}

#[tauri::command]
pub async fn stop_web_server(
    state: tauri::State<'_, WebServerState>,
) -> Result<(), AppCommandError> {
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.abort();
    }
    state.running.store(false, Ordering::Relaxed);
    state.port.store(0, Ordering::Relaxed);
    *state.token.lock().unwrap() = String::new();
    eprintln!("[WEB] Web server stopped");
    Ok(())
}

#[tauri::command]
pub async fn get_web_server_status(
    state: tauri::State<'_, WebServerState>,
) -> Result<Option<WebServerInfo>, AppCommandError> {
    if !state.running.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let port = state.port.load(Ordering::Relaxed);
    let token = state.token.lock().unwrap().clone();
    let addresses = get_local_addresses(port);
    Ok(Some(WebServerInfo {
        port,
        token,
        addresses,
    }))
}
