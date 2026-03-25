use axum::{
    extract::Extension,
    http::{StatusCode, Uri},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use super::{auth, handlers, ws};

pub fn build_router(app: tauri::AppHandle, token: String, static_dir: std::path::PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let token_for_ws = token.clone();

    let api = Router::new()
        // Health check (lightweight, used for token validation)
        .route("/health", post(health_check))
        // Conversations
        .route("/list_conversations", post(handlers::conversations::list_conversations))
        .route("/get_conversation", post(handlers::conversations::get_conversation))
        .route("/list_folder_conversations", post(handlers::conversations::list_folder_conversations))
        .route("/get_folder_conversation", post(handlers::conversations::get_folder_conversation))
        .route("/import_local_conversations", post(handlers::conversations::import_local_conversations))
        .route("/list_folders", post(handlers::conversations::list_folders))
        .route("/get_stats", post(handlers::conversations::get_stats))
        .route("/get_sidebar_data", post(handlers::conversations::get_sidebar_data))
        .route("/create_conversation", post(handlers::conversations::create_conversation))
        .route("/update_conversation_status", post(handlers::conversations::update_conversation_status))
        .route("/update_conversation_title", post(handlers::conversations::update_conversation_title))
        .route("/delete_conversation", post(handlers::conversations::delete_conversation))
        // Folders
        .route("/load_folder_history", post(handlers::folders::load_folder_history))
        .route("/get_folder", post(handlers::folders::get_folder))
        .route("/open_folder_window", post(handlers::folders::open_folder_window))
        // System settings
        .route("/get_system_proxy_settings", post(handlers::system_settings::get_system_proxy_settings))
        .route("/get_system_language_settings", post(handlers::system_settings::get_system_language_settings))
        // Catch-all: return proper JSON 404 for unimplemented API endpoints
        .fallback(api_not_found)
        // Auth middleware for API routes
        .layer(middleware::from_fn(move |req, next| {
            auth::require_token(req, next, token.clone())
        }));

    // WebSocket route (auth via query param)
    let ws_route = Router::new()
        .route("/ws/events", get(ws::ws_handler))
        .layer(middleware::from_fn(move |req, next| {
            auth::require_token(req, next, token_for_ws.clone())
        }));

    // Static file serving.
    // Next.js static export produces "folder.html" for "/folder" route.
    // We use a middleware to rewrite "/folder" → "/folder.html" before ServeDir.
    let fallback = ServeDir::new(&static_dir)
        .fallback(ServeFile::new(static_dir.join("index.html")));

    let static_dir_for_mw = static_dir.clone();
    let html_rewrite = middleware::from_fn(move |req: axum::extract::Request, next: Next| {
        let dir = static_dir_for_mw.clone();
        async move {
            let path = req.uri().path();
            // If path has no extension (not a file) and a .html version exists, rewrite
            if path != "/" && !path.contains('.') && !path.starts_with("/api") && !path.starts_with("/ws") {
                let html_path = format!("{}.html", path.trim_end_matches('/'));
                let html_file = dir.join(html_path.trim_start_matches('/'));
                if html_file.exists() {
                    // Rebuild URI with .html suffix preserving query string
                    let new_path = if let Some(q) = req.uri().query() {
                        format!("{}?{}", html_path, q)
                    } else {
                        html_path
                    };
                    if let Ok(new_uri) = new_path.parse::<Uri>() {
                        let (mut parts, body) = req.into_parts();
                        parts.uri = new_uri;
                        let req = axum::extract::Request::from_parts(parts, body);
                        return next.run(req).await;
                    }
                }
            }
            next.run(req).await
        }
    });

    Router::new()
        .nest("/api", api)
        .merge(ws_route)
        .fallback_service(fallback)
        .layer(html_rewrite)
        .layer(cors)
        .layer(Extension(app))
}

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn api_not_found(uri: axum::http::Uri) -> impl IntoResponse {
    let command = uri.path().trim_start_matches('/');
    eprintln!("[WEB] Unimplemented API endpoint: {}", command);
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "code": "not_implemented",
            "message": format!("API endpoint '{}' is not available in web mode", command),
        })),
    )
}
