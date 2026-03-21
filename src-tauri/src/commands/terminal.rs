use std::collections::HashMap;

use tauri::Manager;
use tauri::State;

use crate::db::AppDatabase;
use crate::git_credential;
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{SpawnOptions, TerminalManager};
use crate::terminal::types::TerminalInfo;

/// Build extra env vars and a temp credential file for the terminal session.
///
/// Uses `GIT_ASKPASS` with a terminal-specific askpass script that reads from
/// a credential store file. This approach does NOT override the user's
/// existing `credential.helper` configuration (e.g. macOS Keychain).
async fn prepare_credential_env(
    db: &AppDatabase,
    app_data_dir: &std::path::Path,
    terminal_id: &str,
) -> (Option<HashMap<String, String>>, Option<std::path::PathBuf>) {
    let accounts = match git_credential::load_github_accounts(&db.conn).await {
        Some(s) if !s.accounts.is_empty() => s.accounts,
        _ => return (None, None),
    };

    let cred_file = app_data_dir.join(format!("git-creds-{}.tmp", terminal_id));
    if let Err(e) = git_credential::write_credential_store_file(&accounts, &cred_file) {
        eprintln!("[TERM] failed to write credential store file: {}", e);
        return (None, None);
    }

    let askpass_script =
        match git_credential::create_terminal_askpass_script(app_data_dir, &cred_file) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[TERM] failed to create terminal askpass script: {}", e);
                let _ = std::fs::remove_file(&cred_file);
                return (None, None);
            }
        };

    let mut env = HashMap::new();
    env.insert(
        "GIT_ASKPASS".to_string(),
        askpass_script.to_string_lossy().to_string(),
    );

    (Some(env), Some(cred_file))
}

#[tauri::command]
pub async fn terminal_spawn(
    working_dir: String,
    initial_command: Option<String>,
    manager: State<'_, TerminalManager>,
    db: State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, TerminalError> {
    // Generate terminal ID early so we can use it for the credential file name
    let terminal_id = uuid::Uuid::new_v4().to_string();

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

    let (extra_env, cred_file) =
        prepare_credential_env(&db, &app_data_dir, &terminal_id).await;

    manager.spawn_with_id(
        SpawnOptions {
            terminal_id,
            working_dir,
            owner_window_label: window.label().to_string(),
            initial_command,
            extra_env,
            credential_file: cred_file,
        },
        app_handle,
    )
}

#[tauri::command]
pub fn terminal_write(
    terminal_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.write(&terminal_id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(
    terminal_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub fn terminal_kill(
    terminal_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), TerminalError> {
    manager.kill(&terminal_id)
}

#[tauri::command]
pub fn terminal_list(
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<TerminalInfo>, TerminalError> {
    Ok(manager.list_with_exit_check(Some(&app_handle)))
}
