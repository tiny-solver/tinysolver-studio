use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::web::{do_get_web_server_status, do_stop_web_server, WebServerInfo};

pub async fn get_web_server_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Option<WebServerInfo>>, AppCommandError> {
    Ok(Json(do_get_web_server_status(&state.web_server_state)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWebServerParams {
    pub port: Option<u16>,
    pub host: Option<String>,
    pub token: Option<String>,
}

pub async fn start_web_server(
    Extension(state): Extension<Arc<AppState>>,
    Json(_params): Json<StartWebServerParams>,
) -> Result<Json<WebServerInfo>, AppCommandError> {
    // In web mode, the server is already running (this handler itself is served by it).
    // This endpoint is mainly useful in Tauri mode. Return current status as a noop.
    let ws = &state.web_server_state;
    if ws.running.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(info) = do_get_web_server_status(ws) {
            return Ok(Json(info));
        }
    }
    Err(AppCommandError::new(
        crate::app_error::AppErrorCode::InvalidInput,
        "Cannot start web server from within web mode",
    ))
}

pub async fn stop_web_server(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    do_stop_web_server(&state.web_server_state);
    Ok(Json(()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub current_version: &'static str,
    pub update: Option<()>,
}

pub async fn check_app_update() -> Json<AppUpdateCheckResult> {
    Json(AppUpdateCheckResult {
        current_version: env!("CARGO_PKG_VERSION"),
        update: None,
    })
}
