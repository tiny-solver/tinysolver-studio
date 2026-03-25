use axum::{extract::Extension, Json};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::commands::folders as folder_commands;
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

// --- New handlers below ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFolderOpenedConversationsParams {
    pub folder_id: i32,
    pub items: Vec<OpenedConversation>,
}

pub async fn save_folder_opened_conversations(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<SaveFolderOpenedConversationsParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_service::save_opened_conversations(&db.conn, params.folder_id, params.items)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    pub path: String,
}

pub async fn get_git_branch(
    Json(params): Json<PathParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    let result = folder_commands::get_git_branch(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFileTreeParams {
    pub path: String,
    pub max_depth: Option<usize>,
}

pub async fn get_file_tree(
    Json(params): Json<GetFileTreeParams>,
) -> Result<Json<Vec<folder_commands::FileTreeNode>>, AppCommandError> {
    let result = folder_commands::get_file_tree(params.path, params.max_depth).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootPathParams {
    pub root_path: String,
}

pub async fn start_file_tree_watch(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<RootPathParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::start_file_tree_watch(app, params.root_path).await?;
    Ok(Json(()))
}

pub async fn stop_file_tree_watch(
    Json(params): Json<RootPathParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::stop_file_tree_watch(params.root_path).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSettingsWindowParams {
    pub section: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsNavigationResult {
    pub path: String,
}

/// Web equivalent of `open_settings_window`: returns the target navigation path.
/// The web client handles the actual navigation.
pub async fn open_settings_window(
    Json(params): Json<OpenSettingsWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    let route = match params.section.as_deref() {
        Some("appearance") => "settings/appearance",
        Some("agents") => "settings/agents",
        Some("mcp") => "settings/mcp",
        Some("skills") => "settings/skills",
        Some("shortcuts") => "settings/shortcuts",
        Some("system") => "settings/system",
        _ => "settings/system",
    };

    let path = if route == "settings/agents" {
        if let Some(ref agent) = params.agent_type {
            let trimmed = agent.trim();
            if !trimmed.is_empty()
                && trimmed
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
            {
                format!("/{route}?agent={trimmed}")
            } else {
                format!("/{route}")
            }
        } else {
            format!("/{route}")
        }
    } else {
        format!("/{route}")
    };

    Ok(Json(SettingsNavigationResult { path }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusParams {
    pub path: String,
    pub show_all_untracked: Option<bool>,
}

pub async fn git_status(
    Json(params): Json<GitStatusParams>,
) -> Result<Json<Vec<folder_commands::GitStatusEntry>>, AppCommandError> {
    let result =
        folder_commands::git_status(params.path, params.show_all_untracked).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFilePreviewParams {
    pub root_path: String,
    pub path: String,
}

pub async fn read_file_preview(
    Json(params): Json<ReadFilePreviewParams>,
) -> Result<Json<folder_commands::FilePreviewContent>, AppCommandError> {
    let result =
        folder_commands::read_file_preview(params.root_path, params.path).await?;
    Ok(Json(result))
}

pub async fn git_list_all_branches(
    Json(params): Json<PathParams>,
) -> Result<Json<folder_commands::GitBranchList>, AppCommandError> {
    let result = folder_commands::git_list_all_branches(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitBranchesParams {
    pub path: String,
    pub commit: String,
}

pub async fn git_commit_branches(
    Json(params): Json<GitCommitBranchesParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let result =
        folder_commands::git_commit_branches(params.path, params.commit).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowFileParams {
    pub path: String,
    pub file: String,
    pub ref_name: Option<String>,
}

pub async fn git_show_file(
    Json(params): Json<GitShowFileParams>,
) -> Result<Json<String>, AppCommandError> {
    let result =
        folder_commands::git_show_file(params.path, params.file, params.ref_name).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffParams {
    pub path: String,
    pub file: Option<String>,
}

pub async fn git_diff(
    Json(params): Json<GitDiffParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = folder_commands::git_diff(params.path, params.file).await?;
    Ok(Json(result))
}

pub async fn git_list_remotes(
    Json(params): Json<PathParams>,
) -> Result<Json<Vec<folder_commands::GitRemote>>, AppCommandError> {
    let result = folder_commands::git_list_remotes(params.path).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCommitWindowParams {
    pub folder_id: i32,
}

/// Web equivalent of `open_commit_window`: returns the navigation path.
pub async fn open_commit_window(
    Json(params): Json<OpenCommitWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    Ok(Json(SettingsNavigationResult {
        path: format!("/commit?folderId={}", params.folder_id),
    }))
}
