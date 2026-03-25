use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::folders as folder_commands;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogParams {
    pub path: String,
    pub limit: Option<u32>,
    pub branch: Option<String>,
    pub remote: Option<String>,
}

pub async fn git_log(
    Json(params): Json<GitLogParams>,
) -> Result<Json<folder_commands::GitLogResult>, AppCommandError> {
    let result =
        folder_commands::git_log(params.path, params.limit, params.branch, params.remote).await?;
    Ok(Json(result))
}
