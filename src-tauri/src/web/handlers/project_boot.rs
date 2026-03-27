use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::project_boot as pb_commands;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct DetectPackageManagerParams {
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShadcnProjectParams {
    pub project_name: String,
    pub template: String,
    pub preset_code: String,
    pub package_manager: String,
    pub target_dir: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn detect_package_manager(
    Json(params): Json<DetectPackageManagerParams>,
) -> Json<pb_commands::PackageManagerInfo> {
    let info = pb_commands::detect_package_manager(params.name).await;
    Json(info)
}

pub async fn create_shadcn_project(
    Json(params): Json<CreateShadcnProjectParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = pb_commands::create_shadcn_project(
        params.project_name,
        params.template,
        params.preset_code,
        params.package_manager,
        params.target_dir,
    )
    .await?;
    Ok(Json(result))
}
