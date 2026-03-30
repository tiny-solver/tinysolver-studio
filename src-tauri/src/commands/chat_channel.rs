use crate::app_error::AppCommandError;
use crate::chat_channel::backends::lark::LarkBackend;
use crate::chat_channel::backends::telegram::TelegramBackend;
use crate::chat_channel::manager::ChatChannelManager;
use crate::chat_channel::traits::ChatChannelBackend;
use crate::chat_channel::types::ChannelType;
use crate::db::service::{chat_channel_message_log_service, chat_channel_service};
use crate::db::AppDatabase;
use crate::models::chat_channel::{ChannelStatusInfo, ChatChannelInfo, ChatChannelMessageLogInfo};

// ---------------------------------------------------------------------------
// Shared core functions (used by both Tauri commands and web handlers)
// ---------------------------------------------------------------------------

pub async fn list_chat_channels_core(
    db: &AppDatabase,
) -> Result<Vec<ChatChannelInfo>, AppCommandError> {
    let rows = chat_channel_service::list_all(&db.conn)
        .await
        .map_err(AppCommandError::from)?;
    Ok(rows.into_iter().map(ChatChannelInfo::from).collect())
}

pub async fn create_chat_channel_core(
    db: &AppDatabase,
    name: String,
    channel_type: String,
    config_json: String,
    enabled: bool,
    daily_report_enabled: bool,
    daily_report_time: Option<String>,
) -> Result<ChatChannelInfo, AppCommandError> {
    // Validate channel_type
    let _: ChannelType = serde_json::from_value(serde_json::Value::String(channel_type.clone()))
        .map_err(|_| {
            AppCommandError::invalid_input(format!("Invalid channel type: {channel_type}"))
        })?;

    let model = chat_channel_service::create(
        &db.conn,
        name,
        channel_type,
        config_json,
        enabled,
        daily_report_enabled,
        daily_report_time,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(ChatChannelInfo::from(model))
}

pub async fn update_chat_channel_core(
    db: &AppDatabase,
    id: i32,
    name: Option<String>,
    enabled: Option<bool>,
    config_json: Option<String>,
    event_filter_json: Option<Option<String>>,
    daily_report_enabled: Option<bool>,
    daily_report_time: Option<Option<String>>,
) -> Result<ChatChannelInfo, AppCommandError> {
    let model = chat_channel_service::update(
        &db.conn,
        id,
        name,
        enabled,
        config_json,
        event_filter_json,
        daily_report_enabled,
        daily_report_time,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(ChatChannelInfo::from(model))
}

pub async fn delete_chat_channel_core(db: &AppDatabase, id: i32) -> Result<(), AppCommandError> {
    chat_channel_service::delete(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let _ = crate::keyring_store::delete_channel_token(id);
    Ok(())
}

pub async fn connect_chat_channel_core(
    db: &AppDatabase,
    manager: &ChatChannelManager,
    id: i32,
) -> Result<(), AppCommandError> {
    let model = chat_channel_service::get_by_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Chat channel {id} not found")))?;

    let channel_type: ChannelType =
        serde_json::from_value(serde_json::Value::String(model.channel_type.clone()))
            .map_err(|_| {
                AppCommandError::configuration_invalid(format!(
                    "Invalid channel type: {}",
                    model.channel_type
                ))
            })?;

    let backend: Box<dyn crate::chat_channel::traits::ChatChannelBackend> = match channel_type {
        ChannelType::Telegram => {
            let config: serde_json::Value =
                serde_json::from_str(&model.config_json).map_err(|e| {
                    AppCommandError::configuration_invalid("Invalid config JSON")
                        .with_detail(e.to_string())
                })?;
            let chat_id = config
                .get("chat_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("chat_id is required"))?
                .to_string();
            let bot_token = crate::keyring_store::get_channel_token(id).ok_or_else(|| {
                AppCommandError::configuration_missing("Bot token not set")
            })?;
            Box::new(TelegramBackend::new(id, bot_token, chat_id))
        }
        ChannelType::Lark => {
            let config: serde_json::Value =
                serde_json::from_str(&model.config_json).map_err(|e| {
                    AppCommandError::configuration_invalid("Invalid config JSON")
                        .with_detail(e.to_string())
                })?;
            let app_id = config
                .get("app_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("app_id is required"))?
                .to_string();
            let chat_id = config
                .get("chat_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("chat_id is required"))?
                .to_string();
            let app_secret = crate::keyring_store::get_channel_token(id).ok_or_else(|| {
                AppCommandError::configuration_missing("App Secret not set")
            })?;
            Box::new(LarkBackend::new(id, app_id, app_secret, chat_id))
        }
    };

    manager
        .add_channel(id, model.name, channel_type, backend)
        .await
        .map_err(AppCommandError::from)?;

    Ok(())
}

pub async fn test_chat_channel_core(
    db: &AppDatabase,
    id: i32,
) -> Result<(), AppCommandError> {
    let model = chat_channel_service::get_by_id(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found(format!("Chat channel {id} not found")))?;

    let channel_type: ChannelType =
        serde_json::from_value(serde_json::Value::String(model.channel_type.clone()))
            .map_err(|_| {
                AppCommandError::configuration_invalid(format!(
                    "Invalid channel type: {}",
                    model.channel_type
                ))
            })?;

    match channel_type {
        ChannelType::Telegram => {
            let config: serde_json::Value =
                serde_json::from_str(&model.config_json).map_err(|e| {
                    AppCommandError::configuration_invalid("Invalid config JSON")
                        .with_detail(e.to_string())
                })?;
            let chat_id = config
                .get("chat_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("chat_id is required"))?
                .to_string();
            let bot_token = crate::keyring_store::get_channel_token(id).ok_or_else(|| {
                AppCommandError::configuration_missing("Bot token not set")
            })?;
            let backend = TelegramBackend::new(id, bot_token, chat_id);
            backend
                .test_connection()
                .await
                .map_err(AppCommandError::from)?;
        }
        ChannelType::Lark => {
            let config: serde_json::Value =
                serde_json::from_str(&model.config_json).map_err(|e| {
                    AppCommandError::configuration_invalid("Invalid config JSON")
                        .with_detail(e.to_string())
                })?;
            let app_id = config
                .get("app_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("app_id is required"))?
                .to_string();
            let chat_id = config
                .get("chat_id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppCommandError::configuration_missing("chat_id is required"))?
                .to_string();
            let app_secret = crate::keyring_store::get_channel_token(id).ok_or_else(|| {
                AppCommandError::configuration_missing("App Secret not set")
            })?;
            let backend = LarkBackend::new(id, app_id, app_secret, chat_id);
            backend
                .test_connection()
                .await
                .map_err(AppCommandError::from)?;
        }
    }

    Ok(())
}

pub fn save_chat_channel_token_core(channel_id: i32, token: &str) -> Result<(), AppCommandError> {
    crate::keyring_store::set_channel_token(channel_id, token)
        .map_err(|e| AppCommandError::io_error("Failed to save token").with_detail(e))
}

pub fn get_chat_channel_has_token_core(channel_id: i32) -> Result<bool, AppCommandError> {
    Ok(crate::keyring_store::get_channel_token(channel_id).is_some())
}

pub fn delete_chat_channel_token_core(channel_id: i32) -> Result<(), AppCommandError> {
    crate::keyring_store::delete_channel_token(channel_id)
        .map_err(|e| AppCommandError::io_error("Failed to delete token").with_detail(e))
}

pub async fn disconnect_chat_channel_core(
    manager: &ChatChannelManager,
    id: i32,
) -> Result<(), AppCommandError> {
    manager
        .remove_channel(id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(())
}

pub async fn get_chat_channel_status_core(
    manager: &ChatChannelManager,
) -> Result<Vec<ChannelStatusInfo>, AppCommandError> {
    Ok(manager.get_status().await)
}

pub async fn list_chat_channel_messages_core(
    db: &AppDatabase,
    channel_id: i32,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<Vec<ChatChannelMessageLogInfo>, AppCommandError> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    let rows = chat_channel_message_log_service::list_by_channel(&db.conn, channel_id, limit, offset)
        .await
        .map_err(AppCommandError::from)?;
    Ok(rows.into_iter().map(ChatChannelMessageLogInfo::from).collect())
}

// ---------------------------------------------------------------------------
// Tauri commands (use tauri::State for injection)
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_chat_channels(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<ChatChannelInfo>, AppCommandError> {
    list_chat_channels_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn create_chat_channel(
    db: tauri::State<'_, AppDatabase>,
    name: String,
    channel_type: String,
    config_json: String,
    enabled: bool,
    daily_report_enabled: bool,
    daily_report_time: Option<String>,
) -> Result<ChatChannelInfo, AppCommandError> {
    create_chat_channel_core(&db, name, channel_type, config_json, enabled, daily_report_enabled, daily_report_time).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn update_chat_channel(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    name: Option<String>,
    enabled: Option<bool>,
    config_json: Option<String>,
    event_filter_json: Option<Option<String>>,
    daily_report_enabled: Option<bool>,
    daily_report_time: Option<Option<String>>,
) -> Result<ChatChannelInfo, AppCommandError> {
    update_chat_channel_core(&db, id, name, enabled, config_json, event_filter_json, daily_report_enabled, daily_report_time).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_chat_channel(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    delete_chat_channel_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_chat_channel_token(channel_id: i32, token: String) -> Result<(), AppCommandError> {
    save_chat_channel_token_core(channel_id, &token)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_chat_channel_has_token(channel_id: i32) -> Result<bool, AppCommandError> {
    get_chat_channel_has_token_core(channel_id)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn delete_chat_channel_token(channel_id: i32) -> Result<(), AppCommandError> {
    delete_chat_channel_token_core(channel_id)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn connect_chat_channel(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ChatChannelManager>,
    id: i32,
) -> Result<(), AppCommandError> {
    connect_chat_channel_core(&db, &manager, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn disconnect_chat_channel(
    manager: tauri::State<'_, ChatChannelManager>,
    id: i32,
) -> Result<(), AppCommandError> {
    disconnect_chat_channel_core(&manager, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn test_chat_channel(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    test_chat_channel_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_chat_channel_status(
    manager: tauri::State<'_, ChatChannelManager>,
) -> Result<Vec<ChannelStatusInfo>, AppCommandError> {
    get_chat_channel_status_core(&manager).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_chat_channel_messages(
    db: tauri::State<'_, AppDatabase>,
    channel_id: i32,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<Vec<ChatChannelMessageLogInfo>, AppCommandError> {
    list_chat_channel_messages_core(&db, channel_id, limit, offset).await
}
