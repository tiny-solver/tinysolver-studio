use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::content_project as cp_commands;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateContentProjectParams {
    pub project_name: String,
    pub target_dir: String,
    pub template: String,
    pub outputs: Vec<String>,
}

#[derive(Deserialize)]
pub struct ReadContentProjectParams {
    pub path: String,
}

pub async fn list_content_templates() -> Json<Vec<cp_commands::ContentTemplate>> {
    Json(cp_commands::list_content_templates().await)
}

pub async fn create_content_project(
    Json(params): Json<CreateContentProjectParams>,
) -> Result<Json<String>, AppCommandError> {
    let path = cp_commands::create_content_project(
        params.project_name,
        params.target_dir,
        params.template,
        params.outputs,
    )
    .await?;
    Ok(Json(path))
}

pub async fn read_content_project(
    Json(params): Json<ReadContentProjectParams>,
) -> Result<Json<Option<cp_commands::ContentProjectManifest>>, AppCommandError> {
    let manifest = cp_commands::read_content_project(params.path).await?;
    Ok(Json(manifest))
}

#[derive(Deserialize)]
pub struct ProjectRootParams {
    pub root: String,
}

pub async fn list_content_scenes(
    Json(params): Json<ProjectRootParams>,
) -> Result<Json<Vec<cp_commands::ContentScene>>, AppCommandError> {
    Ok(Json(cp_commands::list_content_scenes(params.root).await?))
}

pub async fn list_content_builds(
    Json(params): Json<ProjectRootParams>,
) -> Result<Json<Vec<cp_commands::ContentBuild>>, AppCommandError> {
    Ok(Json(cp_commands::list_content_builds(params.root).await?))
}

pub async fn build_content_project(
    Json(params): Json<ProjectRootParams>,
) -> Result<Json<cp_commands::ContentBuild>, AppCommandError> {
    Ok(Json(cp_commands::build_content_project(params.root).await?))
}

pub async fn get_content_preview(
    Json(params): Json<ProjectRootParams>,
) -> Result<Json<crate::content_preview::ContentPreviewInfo>, AppCommandError> {
    Ok(Json(cp_commands::get_content_preview(params.root).await?))
}
