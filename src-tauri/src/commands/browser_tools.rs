//! The `browser_tools.enabled` setting — whether an agent may see the built-in
//! browser at all.
//!
//! Separate from `commands::browser`, which is the browser itself and exists
//! only in the desktop build: this switch is read by the shared codeg-mcp
//! plumbing (injection, the service-status popover), so it has to compile in
//! server mode too — where it is simply always answered "no" at the point of
//! use, there being no native tabs there.
//!
//! **Off by default**, unlike the other two read-only tool groups. Those hand
//! an agent codeg's own state; this one hands it a listing of the sites the
//! user has open right now, which is the sort of thing that should be a
//! decision rather than a default. Sharing an individual page is a second,
//! per-tab decision on top of it (`crate::browser::agent`) — this switch only
//! decides whether the tools exist.

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::browser_tools::{BrowserToolsConfig, BrowserToolsRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, BROWSER_TOOLS_SETTINGS_CHANGED_EVENT};

pub const KEY_BROWSER_TOOLS_ENABLED: &str = "browser_tools.enabled";

/// Whether `browser_eval` exists at all. Its own key, not a level of the one
/// above: the switch above decides whether an agent may see and read the
/// browser, and this one decides whether it may run its own code in it. The
/// second is not more of the first, and a person who turned the first on has
/// not said anything about the second.
pub const KEY_BROWSER_TOOLS_EVAL_ENABLED: &str = "browser_tools.eval_enabled";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BrowserToolsSettings {
    pub enabled: bool,
    /// Off by default, and meaningless while `enabled` is off — the tool is
    /// part of the browser group, so the group switch covers it too.
    #[serde(default)]
    pub eval: bool,
}

impl BrowserToolsSettings {
    fn into_runtime_config(self) -> BrowserToolsConfig {
        BrowserToolsConfig {
            enabled: self.enabled,
            // Never on without the group: a stored `eval: true` left behind by
            // someone who later switched the whole browser surface off must
            // not be the one thing that survives it.
            eval: self.enabled && self.eval,
        }
    }
}

/// Read the persisted keys from `app_metadata`, falling back to the defaults
/// (both off) for a missing or malformed value. Never errors hard.
pub async fn load_browser_tools_settings(conn: &DatabaseConnection) -> BrowserToolsSettings {
    let mut settings = BrowserToolsSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_BROWSER_TOOLS_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    if let Ok(Some(raw)) =
        app_metadata_service::get_value(conn, KEY_BROWSER_TOOLS_EVAL_ENABLED).await
    {
        if let Ok(v) = raw.parse::<bool>() {
            settings.eval = v;
        }
    }
    settings
}

/// Pull settings from the DB and push the resulting [`BrowserToolsConfig`] onto
/// the shared runtime handle. Idempotent — safe on startup or after any save.
pub async fn apply_persisted_browser_tools_config(
    conn: &DatabaseConnection,
    config: &BrowserToolsRuntimeConfig,
) {
    let settings = load_browser_tools_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Persist + apply + broadcast. Shared by the Tauri command and the HTTP
/// handler so the write + re-apply + notify chain lives in one place.
///
/// The apply is what makes turning this off take effect on sessions that are
/// already running: the access impl reads the same handle on every call.
pub async fn set_browser_tools_settings_core(
    conn: &DatabaseConnection,
    config: &BrowserToolsRuntimeConfig,
    emitter: &EventEmitter,
    desired: BrowserToolsSettings,
) -> Result<BrowserToolsSettings, AppCommandError> {
    app_metadata_service::upsert_value(
        conn,
        KEY_BROWSER_TOOLS_ENABLED,
        &desired.enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_BROWSER_TOOLS_EVAL_ENABLED,
        &desired.eval.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, BROWSER_TOOLS_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_browser_tools_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<BrowserToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_browser_tools_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_browser_tools_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, BrowserToolsRuntimeConfig>,
    settings: BrowserToolsSettings,
) -> Result<BrowserToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_browser_tools_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default is the one thing about this setting worth pinning: a user
    /// who never opens the switch has not handed anyone a list of the sites
    /// they have open, and certainly has not said an agent may run code in
    /// them.
    #[test]
    fn agents_cannot_see_the_browser_until_someone_says_so() {
        assert!(!BrowserToolsSettings::default().enabled);
        assert!(!BrowserToolsSettings::default().eval);
    }

    /// Turning the browser group off takes `browser_eval` with it, whatever
    /// the stored value of the second key says. The two switches are separate
    /// decisions in one direction only: eval is part of the browser surface,
    /// so the surface being off settles it.
    #[test]
    fn eval_cannot_outlive_the_group_it_belongs_to() {
        let orphan = BrowserToolsSettings {
            enabled: false,
            eval: true,
        };
        assert_eq!(
            orphan.into_runtime_config(),
            BrowserToolsConfig {
                enabled: false,
                eval: false,
            }
        );
        let both = BrowserToolsSettings {
            enabled: true,
            eval: true,
        };
        assert_eq!(
            both.into_runtime_config(),
            BrowserToolsConfig {
                enabled: true,
                eval: true,
            }
        );
    }
}
