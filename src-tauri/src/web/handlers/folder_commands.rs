use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::service::folder_command_service;
use crate::db::AppDatabase;
use crate::models::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdParams {
    pub folder_id: i32,
}

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
