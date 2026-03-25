use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::commands::conversations as conv_commands;
use crate::db::service::{conversation_service, folder_service, import_service};
use crate::db::AppDatabase;
use crate::models::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFolderConversationsParams {
    pub folder_id: i32,
    pub agent_type: Option<AgentType>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub status: Option<String>,
}

pub async fn list_folder_conversations(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<ListFolderConversationsParams>,
) -> Result<Json<Vec<DbConversationSummary>>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = conversation_service::list_by_folder(
        &db.conn,
        params.folder_id,
        params.agent_type,
        params.search,
        params.sort_by,
        params.status,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationsParams {
    pub agent_type: Option<AgentType>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub folder_path: Option<String>,
}

pub async fn list_conversations(
    Json(params): Json<ListConversationsParams>,
) -> Result<Json<Vec<ConversationSummary>>, AppCommandError> {
    let result = conv_commands::list_conversations(
        params.agent_type,
        params.search,
        params.sort_by,
        params.folder_path,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConversationParams {
    pub agent_type: AgentType,
    pub conversation_id: String,
}

pub async fn get_conversation(
    Json(params): Json<GetConversationParams>,
) -> Result<Json<ConversationDetail>, AppCommandError> {
    let result =
        conv_commands::get_conversation(params.agent_type, params.conversation_id).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFolderConversationParams {
    pub conversation_id: i32,
}

pub async fn get_folder_conversation(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<GetFolderConversationParams>,
) -> Result<Json<DbConversationDetail>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result =
        conv_commands::get_folder_conversation_core(&db.conn, params.conversation_id).await?;
    Ok(Json(result))
}

pub async fn list_folders() -> Result<Json<Vec<FolderInfo>>, AppCommandError> {
    let result = conv_commands::list_folders().await?;
    Ok(Json(result))
}

pub async fn get_stats() -> Result<Json<AgentStats>, AppCommandError> {
    let result = conv_commands::get_stats().await?;
    Ok(Json(result))
}

pub async fn get_sidebar_data() -> Result<Json<SidebarData>, AppCommandError> {
    let result = conv_commands::get_sidebar_data().await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalConversationsParams {
    pub folder_id: i32,
}

pub async fn import_local_conversations(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<ImportLocalConversationsParams>,
) -> Result<Json<ImportResult>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let folder = folder_service::get_folder_by_id(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("Folder not found"))?;
    let result = import_service::import_local_conversations(&db.conn, params.folder_id, &folder.path)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationParams {
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub title: Option<String>,
}

pub async fn create_conversation(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<CreateConversationParams>,
) -> Result<Json<i32>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let result = conv_commands::create_conversation_core(
        &db.conn,
        params.folder_id,
        params.agent_type,
        params.title,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationStatusParams {
    pub conversation_id: i32,
    pub status: String,
}

pub async fn update_conversation_status(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<UpdateConversationStatusParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let status_enum: crate::db::entities::conversation::ConversationStatus =
        serde_json::from_value(serde_json::Value::String(params.status)).map_err(|e| {
            AppCommandError::invalid_input("Invalid conversation status").with_detail(e.to_string())
        })?;
    conversation_service::update_status(&db.conn, params.conversation_id, status_enum)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationTitleParams {
    pub conversation_id: i32,
    pub title: String,
}

pub async fn update_conversation_title(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<UpdateConversationTitleParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    conversation_service::update_title(&db.conn, params.conversation_id, params.title)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConversationParams {
    pub conversation_id: i32,
}

pub async fn delete_conversation(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<DeleteConversationParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    conversation_service::soft_delete(&db.conn, params.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationExternalIdParams {
    pub conversation_id: i32,
    pub external_id: String,
}

pub async fn update_conversation_external_id(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<UpdateConversationExternalIdParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    conversation_service::update_external_id(&db.conn, params.conversation_id, params.external_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}
