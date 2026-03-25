use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::web::{do_get_web_server_status, do_start_web_server, do_stop_web_server};
use crate::web::{WebServerInfo, WebServerState};

pub async fn get_web_server_status(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<Option<WebServerInfo>>, AppCommandError> {
    let state = app.state::<WebServerState>();
    Ok(Json(do_get_web_server_status(&state)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWebServerParams {
    pub port: Option<u16>,
    pub host: Option<String>,
}

pub async fn start_web_server(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<StartWebServerParams>,
) -> Result<Json<WebServerInfo>, AppCommandError> {
    let state = app.state::<WebServerState>();
    let info = do_start_web_server(&app, &state, params.port, params.host).await?;
    Ok(Json(info))
}

pub async fn stop_web_server(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<()>, AppCommandError> {
    let state = app.state::<WebServerState>();
    do_stop_web_server(&state);
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
