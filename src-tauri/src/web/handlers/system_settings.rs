use axum::{extract::Extension, Json};
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;
use crate::models::*;

const SYSTEM_PROXY_SETTINGS_KEY: &str = "system_proxy_settings";
const SYSTEM_LANGUAGE_SETTINGS_KEY: &str = "system_language_settings";

pub async fn get_system_proxy_settings(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<SystemProxySettings>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let raw = app_metadata_service::get_value(&db.conn, SYSTEM_PROXY_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let settings = raw
        .and_then(|v| serde_json::from_str::<SystemProxySettings>(&v).ok())
        .unwrap_or_default();
    Ok(Json(settings))
}

pub async fn get_system_language_settings(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<SystemLanguageSettings>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let raw = app_metadata_service::get_value(&db.conn, SYSTEM_LANGUAGE_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let settings = raw
        .and_then(|v| serde_json::from_str::<SystemLanguageSettings>(&v).ok())
        .unwrap_or_default();
    Ok(Json(settings))
}
