use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::game_preview as gp;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePreviewDirParams {
    pub root_path: String,
    pub dir: String,
}

pub async fn game_preview_fingerprint(
    Json(params): Json<GamePreviewDirParams>,
) -> Result<Json<String>, AppCommandError> {
    Ok(Json(
        gp::game_preview_fingerprint(params.root_path, params.dir).await?,
    ))
}
