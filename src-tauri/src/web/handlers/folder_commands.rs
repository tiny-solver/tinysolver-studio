use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::service::folder_command_service;
use crate::db::AppDatabase;
use crate::models::*;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdParams {
    pub folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderCommandParams {
    pub folder_id: i32,
    pub name: String,
    pub command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderCommandParams {
    pub id: i32,
    pub name: Option<String>,
    pub command: Option<String>,
    pub sort_order: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderCommandParams {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderFolderCommandsParams {
    pub folder_id: i32,
    pub ids: Vec<i32>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn list_folder_commands(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn create_folder_command(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<CreateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_command_service::create(
        &db.conn,
        params.folder_id,
        &params.name,
        &params.command,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn update_folder_command(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<UpdateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_command_service::update(
        &db.conn,
        params.id,
        params.name,
        params.command,
        params.sort_order,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn delete_folder_command(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<DeleteFolderCommandParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_command_service::delete(&db.conn, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn reorder_folder_commands(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<ReorderFolderCommandsParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_command_service::reorder(&db.conn, params.folder_id, params.ids)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapFolderCommandsParams {
    pub folder_id: i32,
    pub folder_path: String,
}

pub async fn bootstrap_folder_commands_from_package_json(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<BootstrapFolderCommandsParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = app.state::<AppDatabase>();

    let existing = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    if !existing.is_empty() {
        return Ok(Json(existing));
    }

    let commands_to_create = tokio::task::spawn_blocking(move || {
        crate::commands::folder_commands::load_package_scripts_as_commands(&params.folder_path)
    })
    .await
    .map_err(|e| AppCommandError::new(
        crate::app_error::AppErrorCode::TaskExecutionFailed,
        format!("bootstrap task failed: {e}"),
    ))?;

    if commands_to_create.is_empty() {
        return Ok(Json(existing));
    }

    folder_command_service::create_many(&db.conn, params.folder_id, &commands_to_create)
        .await
        .map_err(AppCommandError::from)?;

    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}
