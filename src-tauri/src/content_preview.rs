//! Serves a content project's folder over plain HTTP so the Studio can show
//! the *real* game in an iframe: `outputs/game/index.html` loading its own
//! `src/main.js`, fetching `content/<scene>.studio.json`, and resolving
//! `../../../assets/` — exactly what `npx serve .` from the project root
//! would give, without asking the user to run anything.
//!
//! ## Addressing
//!
//! A root is registered once per process and addressed by an unguessable
//! id, so the URL `.../api/content-preview/<id>/outputs/game/index.html`
//! is both the locator and the capability. That matters because an iframe
//! navigation can't carry the Bearer token: the route lives in the
//! unauthenticated `public_api` router, and the id is what stands in for
//! auth. A leaked id exposes one project folder read-only; the global
//! token is never in the iframe.
//!
//! ## Two listeners, one handler
//!
//! * Server mode: mounted on the main Axum router, so a remote browser
//!   reaches it through the same origin it already talks to.
//! * Desktop mode: the embedded web service is optional and may be off, so
//!   a tiny loopback listener (`127.0.0.1:<ephemeral>`) is started on first
//!   use with only this route. The Tauri webview loads loopback URLs
//!   directly (the CSP is open), the same way office previews do.
//!
//! Both go through [`serve`], which confines every request to its
//! registered root (canonicalized; symlinks pointing outside are refused).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::app_error::AppCommandError;

/// Route prefix, identical on the main router and the loopback listener so
/// the frontend builds one URL shape.
pub const ROUTE_PREFIX: &str = "/api/content-preview";

struct Registry {
    /// id → canonical root
    roots: HashMap<String, PathBuf>,
    /// canonical root → id, so re-registering a folder is idempotent
    ids: HashMap<PathBuf, String>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| {
    Mutex::new(Registry {
        roots: HashMap::new(),
        ids: HashMap::new(),
    })
});

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn new_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Register a project root and return its preview id. The same folder
/// (after canonicalization) always maps to the same id for the process
/// lifetime, so reopening the Studio reuses the URL.
pub fn register_root(root: &Path) -> Result<String, AppCommandError> {
    let canonical = root.canonicalize().map_err(|e| {
        AppCommandError::not_found(format!("Project folder not found: {e}"))
    })?;
    if !canonical.is_dir() {
        return Err(AppCommandError::invalid_input("Project path is not a directory"));
    }
    let mut registry = lock();
    if let Some(id) = registry.ids.get(&canonical) {
        return Ok(id.clone());
    }
    let id = new_id();
    registry.roots.insert(id.clone(), canonical.clone());
    registry.ids.insert(canonical, id.clone());
    Ok(id)
}

fn root_for(id: &str) -> Option<PathBuf> {
    lock().roots.get(id).cloned()
}

/// Resolve `rel` inside `root`, refusing traversal, absolute paths, dot
/// segments, and symlinks that escape. A directory resolves to its
/// `index.html`.
pub(crate) fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/');
    let mut path = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => {
                if part.to_string_lossy().starts_with('.') {
                    return None;
                }
                path.push(part);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if path.is_dir() {
        path.push("index.html");
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

pub(crate) fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Classic (non-module) script injected into every served HTML page. It runs
/// before the game's module scripts and reports runtime problems to the
/// embedding Studio as `{ type: "codeg:error", kind, message }`, so the editor
/// can show them and hand them to the agent. Injected here rather than asked
/// of the engine because an agent is free to rewrite the engine, and the
/// errors that matter most are the ones from code nobody has reviewed yet.
/// Only the preview gets it — a packaged build is a plain file copy.
///
/// It is preceded by the preview marker `window.__codegPreview = { scope }`:
/// the engine speaks the editor protocol only when it sees it (an iframe
/// alone is not proof — afterplay runs games in one too), and the `studio`
/// platform adapter keys its fake saves by `scope`, which, unlike the
/// preview id, survives a Studio restart.
const ERROR_REPORTER: &str = r#"(function(){
if(window.parent===window)return;
var seen=0;
function send(kind,detail){
  if(seen++>50)return;
  var m=detail&&detail.message?detail.message:String(detail==null?"":detail);
  if(detail&&detail.stack)m+="\n"+String(detail.stack).split("\n").slice(0,4).join("\n");
  try{parent.postMessage({type:"codeg:error",kind:kind,message:m.slice(0,2000)},"*")}catch(e){}
}
addEventListener("error",function(e){
  if(e.target&&e.target!==window&&(e.target.src||e.target.href))send("resource","Failed to load "+(e.target.src||e.target.href));
  else send("error",e.error||e.message);
},true);
addEventListener("unhandledrejection",function(e){send("rejection",e.reason)});
var orig=console.error;
console.error=function(){
  orig.apply(console,arguments);
  send("console",Array.prototype.map.call(arguments,function(a){return a&&a.message?a.message:String(a)}).join(" "));
};
})();</script>"#;

/// Stable per-folder key for the preview marker. Not a secret — it only
/// separates one project's fake saves from another's in the same webview.
fn preview_scope(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Prepare a served page: add the platform to an old import map, then put
/// the marker and the reporter first in `<head>` (or at the very top when the
/// page has none) so they are installed before any other script runs.
fn inject_reporter(html: &[u8], scope: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(html);
    let text = crate::content_engine::with_platform_import(&text)
        .map(std::borrow::Cow::Owned)
        .unwrap_or(text);
    let lower = text.to_ascii_lowercase();
    let at = lower
        .find("<head")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
        .unwrap_or(0);
    let mut out = String::with_capacity(text.len() + ERROR_REPORTER.len() + 100);
    out.push_str(&text[..at]);
    out.push_str("<script data-codeg-preview>window.__codegPreview={scope:\"");
    out.push_str(scope);
    out.push_str("\"};");
    out.push_str(ERROR_REPORTER);
    out.push_str(&text[at..]);
    out.into_bytes()
}

/// Serve one file of a registered root. Shared by both listeners.
pub async fn serve(id: &str, rel: &str) -> Response {
    let Some(root) = root_for(id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The managed engine: answered from the binary, never from the folder, so
    // a project cannot shadow (or be asked to carry) the runtime.
    if crate::content_engine::is_reserved(rel) {
        return match crate::content_engine::lookup(rel) {
            Some(file) => {
                let mut response = Response::new(Body::from(file.bytes));
                let headers = response.headers_mut();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(file.content_type));
                headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
            }
            None => StatusCode::NOT_FOUND.into_response(),
        };
    }
    let Some(path) = resolve(&root, rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let bytes = if content_type(&path).starts_with("text/html") {
                inject_reporter(&bytes, &preview_scope(&root))
            } else {
                bytes
            };
            let mut response = Response::new(Body::from(bytes));
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&path)));
            // The whole point is seeing the latest edit: never cache.
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub async fn handle(AxumPath((id, rest)): AxumPath<(String, String)>) -> Response {
    serve(&id, &rest).await
}

pub async fn handle_root(AxumPath(id): AxumPath<String>) -> Response {
    serve(&id, "").await
}

/// Mount the preview routes on a router. Used by the main API router and by
/// the loopback listener.
pub fn routes() -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route(&format!("{ROUTE_PREFIX}/{{id}}"), get(handle_root))
        .route(&format!("{ROUTE_PREFIX}/{{id}}/"), get(handle_root))
        .route(&format!("{ROUTE_PREFIX}/{{id}}/{{*rest}}"), get(handle))
}

static LOOPBACK_PORT: tokio::sync::OnceCell<u16> = tokio::sync::OnceCell::const_new();

/// Port of the desktop loopback listener, binding it on first call.
pub async fn loopback_port() -> Result<u16, AppCommandError> {
    LOOPBACK_PORT
        .get_or_try_init(|| async {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(AppCommandError::io)?;
            let port = listener.local_addr().map_err(AppCommandError::io)?.port();
            // Published games ride on the same listener, so a desktop with
            // the web service off still has a working `/play/<slug>/` link.
            let router = routes().merge(crate::content_publish::routes()).layer(
                tower_http::cors::CorsLayer::new()
                    .allow_origin(tower_http::cors::Any)
                    .allow_methods(tower_http::cors::Any),
            );
            tokio::spawn(async move {
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!("[ContentPreview] loopback listener stopped: {e}");
                }
            });
            tracing::info!("[ContentPreview] loopback listener on 127.0.0.1:{port}");
            Ok::<u16, AppCommandError>(port)
        })
        .await
        .cloned()
}

/// What the frontend needs to build the iframe URL.
#[derive(Debug, Clone, Serialize)]
pub struct ContentPreviewInfo {
    pub id: String,
    /// Path on the API origin: `/api/content-preview/<id>/`.
    pub path: String,
    /// Desktop only: a loopback origin the webview can load directly. The
    /// server binary leaves this `None` so browsers use the API origin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loopback: Option<String>,
}

/// Register the folder and describe how to reach it. `loopback` is filled
/// in only for the desktop runtime, where the API origin may not exist.
pub async fn describe(root: &str, desktop: bool) -> Result<ContentPreviewInfo, AppCommandError> {
    let id = register_root(Path::new(root.trim()))?;
    let path = format!("{ROUTE_PREFIX}/{id}/");
    let loopback = if desktop {
        Some(format!("http://127.0.0.1:{}", loopback_port().await?))
    } else {
        None
    };
    Ok(ContentPreviewInfo { id, path, loopback })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_inside_root_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("outputs/game/src")).unwrap();
        std::fs::write(root.join("outputs/game/index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(root.join("outputs/game/src/main.js"), "export {}").unwrap();
        std::fs::write(root.join(".secret"), "no").unwrap();
        // 이름 앞의 `_` 는 Windows 용이다 — 심링크를 만드는 쪽이 cfg(unix) 라 거기서는
        // 이 바인딩이 안 쓰이고, CI 의 `clippy -D warnings` 가 unused_variables 로 떨어진다.
        // 파일은 테스트가 끝날 때까지 살아 있어야 한다(심링크 대상이 유효해야 하므로) —
        // 그래서 cfg 블록 안으로 옮기지 않고 바인딩만 밑줄로 둔다.
        let _outside = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(_outside.path(), root.join("outputs/link")).unwrap();

        let id = register_root(root).unwrap();
        assert_eq!(register_root(root).unwrap(), id, "idempotent");

        let ok = serve(&id, "outputs/game/index.html").await;
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(
            ok.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        assert_eq!(ok.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");

        let body = axum::body::to_bytes(ok.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.starts_with("<script data-codeg-preview>"), "no <head>: reporter goes first");
        assert!(body.contains(&format!("window.__codegPreview={{scope:\"{}\"}}", preview_scope(&root.canonicalize().unwrap()))));
        assert!(body.ends_with("<h1>hi</h1>"));

        let js = serve(&id, "outputs/game/src/main.js").await;
        assert_eq!(js.headers().get(header::CONTENT_TYPE).unwrap(), "text/javascript; charset=utf-8");

        // Directory → index.html
        assert_eq!(serve(&id, "outputs/game/").await.status(), StatusCode::OK);
        assert_eq!(serve(&id, "outputs/game").await.status(), StatusCode::OK);

        for bad in ["../x", "outputs/../../etc/passwd", ".secret", "/etc/passwd", "outputs/link"] {
            assert_eq!(serve(&id, bad).await.status(), StatusCode::NOT_FOUND, "{bad}");
        }
        assert_eq!(serve("nope", "outputs/game/index.html").await.status(), StatusCode::NOT_FOUND);

        // The managed engine is served from the binary, even when the folder
        // has a file at that path.
        std::fs::create_dir_all(root.join("__codeg/engine/three-web")).unwrap();
        std::fs::write(root.join("__codeg/engine/three-web/runtime.js"), "shadow").unwrap();
        let runtime = serve(&id, "__codeg/engine/three-web/runtime.js").await;
        assert_eq!(runtime.status(), StatusCode::OK);
        assert_eq!(runtime.headers().get(header::CONTENT_TYPE).unwrap(), "text/javascript; charset=utf-8");
        let body = axum::body::to_bytes(runtime.into_body(), usize::MAX).await.unwrap();
        assert!(body.starts_with(b"// codeg-engine"));
        assert_eq!(serve(&id, "__codeg/vendor/three.module.min.js").await.status(), StatusCode::OK);
        // The platform entry is the preview's fake, whatever the build target.
        let platform = serve(&id, "__codeg/platform/current.js").await;
        assert_eq!(platform.status(), StatusCode::OK);
        let body = axum::body::to_bytes(platform.into_body(), usize::MAX).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("makePlatform(\"studio\""));
        assert_eq!(serve(&id, "__codeg/platform/core.js").await.status(), StatusCode::OK);
        assert_eq!(serve(&id, "__codeg/other.js").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(serve("nope", "__codeg/vendor/three.module.min.js").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(serve(&id, "outputs/game/missing.png").await.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn reporter_lands_right_after_the_head_tag() {
        let page = b"<!doctype html><html><HEAD lang=\"ko\"><script type=\"module\" src=\"a.js\"></script></head></html>";
        let out = String::from_utf8(inject_reporter(page, "s")).unwrap();
        let head = out.find("<HEAD lang=\"ko\">").unwrap() + "<HEAD lang=\"ko\">".len();
        assert!(out[head..].starts_with("<script data-codeg-preview>"));
        assert!(out.find("data-codeg-preview").unwrap() < out.find("a.js").unwrap());
        assert_eq!(out.matches("codeg:error").count(), 1);
        assert!(out.contains("window.__codegPreview={scope:\"s\"}"));

        // An import map from before the platform layer gets the entry.
        let old = b"<head><script type=\"importmap\">{\"imports\":{\"codeg-engine\":\"../../__codeg/engine/three-web/runtime.js\"}}</script></head>";
        let out = String::from_utf8(inject_reporter(old, "s")).unwrap();
        assert!(out.contains("\"codeg-platform\": \"../../__codeg/platform/current.js\""));
    }

    #[test]
    fn rejects_missing_or_file_roots() {
        assert!(register_root(Path::new("/definitely/not/here")).is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(register_root(file.path()).is_err());
    }
}
