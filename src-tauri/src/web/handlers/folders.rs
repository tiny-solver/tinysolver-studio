use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::service::folder_service;
use crate::db::AppDatabase;
use crate::models::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdParams {
    pub folder_id: i32,
}

pub async fn load_folder_history(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<Vec<FolderHistoryEntry>>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_service::list_folders(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn get_folder(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let folder = folder_service::get_folder_by_id(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;
    Ok(Json(folder))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFolderParams {
    pub path: String,
}

/// Web equivalent of `open_folder_window`: adds the folder to DB and returns its ID.
/// The web client then navigates to `/folder?id=N` itself.
pub async fn open_folder_window(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<FolderHistoryEntry>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let entry = folder_service::add_folder(&db.conn, &params.path)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(entry))
}

// TODO: Add remaining folder handlers (git operations, file operations, etc.)
// These will be added incrementally as needed.
