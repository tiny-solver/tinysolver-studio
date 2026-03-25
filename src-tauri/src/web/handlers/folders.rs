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

pub async fn list_open_folders(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<Vec<FolderHistoryEntry>>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_service::list_open_folders(&db.conn)
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

pub async fn close_folder_window(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_service::set_folder_open(&db.conn, params.folder_id, false)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMergeWindowParams {
    pub folder_id: i32,
    pub operation: Option<String>,
    pub upstream_commit: Option<String>,
}

pub async fn open_merge_window(
    Json(params): Json<OpenMergeWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    let mut path = format!("/merge?folderId={}", params.folder_id);
    if let Some(op) = &params.operation {
        path.push_str(&format!("&operation={op}"));
    }
    if let Some(uc) = &params.upstream_commit {
        path.push_str(&format!("&upstreamCommit={uc}"));
    }
    Ok(Json(SettingsNavigationResult { path }))
}

pub async fn open_stash_window(
    Json(params): Json<OpenCommitWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    Ok(Json(SettingsNavigationResult {
        path: format!("/stash?folderId={}", params.folder_id),
    }))
}

pub async fn open_push_window(
    Json(params): Json<OpenCommitWindowParams>,
) -> Result<Json<SettingsNavigationResult>, AppCommandError> {
    Ok(Json(SettingsNavigationResult {
        path: format!("/push?folderId={}", params.folder_id),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFolderParentBranchParams {
    pub path: String,
    pub parent_branch: Option<String>,
}

pub async fn add_folder_to_history(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<FolderHistoryEntry>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = folder_service::add_folder(&db.conn, &params.path)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn set_folder_parent_branch(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<SetFolderParentBranchParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_commands::set_folder_parent_branch_core(&db.conn, &params.path, params.parent_branch)
        .await?;
    Ok(Json(()))
}

pub async fn remove_folder_from_history(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AddFolderParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    folder_service::remove_folder(&db.conn, &params.path)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn create_folder_directory(
    Json(params): Json<AddFolderParams>,
) -> Result<Json<()>, AppCommandError> {
    folder_commands::create_folder_directory(params.path).await?;
    Ok(Json(()))
}
