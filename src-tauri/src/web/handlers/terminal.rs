use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::commands::terminal::prepare_credential_env;
use crate::terminal::manager::{SpawnOptions, TerminalManager};
use crate::terminal::types::TerminalInfo;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnParams {
    pub working_dir: String,
    pub initial_command: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdParams {
    pub terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn terminal_spawn(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<TerminalSpawnParams>,
) -> Result<Json<String>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    let terminal_id = uuid::Uuid::new_v4().to_string();

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    let extra_env = prepare_credential_env(&app_data_dir);

    let id = manager
        .spawn_with_id(
            SpawnOptions {
                terminal_id,
                working_dir: params.working_dir,
                owner_window_label: "web".to_string(),
                initial_command: params.initial_command,
                extra_env,
                temp_files: vec![],
            },
            app.clone(),
        )
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    Ok(Json(id))
}

pub async fn terminal_write(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<TerminalWriteParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    manager
        .write(&params.terminal_id, params.data.as_bytes())
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn terminal_resize(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<TerminalResizeParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    manager
        .resize(&params.terminal_id, params.cols, params.rows)
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn terminal_kill(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<TerminalIdParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    manager
        .kill(&params.terminal_id)
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn terminal_list(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<Vec<TerminalInfo>>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    let result = manager.list_with_exit_check(Some(&app));
    Ok(Json(result))
}
