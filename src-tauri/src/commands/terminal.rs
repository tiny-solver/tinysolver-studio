use std::collections::HashMap;

use tauri::Manager;
use tauri::State;

use crate::db::AppDatabase;
use crate::git_credential;
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{SpawnOptions, TerminalManager};
use crate::terminal::types::TerminalInfo;

/// Temp files created for a terminal credential session.
struct TerminalCredFiles {
    cred_file: std::path::PathBuf,
    helper_script: std::path::PathBuf,
}

/// Build extra env vars and temp credential files for the terminal session.
///
/// Uses `credential.helper` with a custom credential helper script that speaks
/// git's structured credential protocol (host/protocol on stdin, username/password
/// on stdout). This is added via `GIT_CONFIG_COUNT` which APPENDS to the user's
/// existing credential helpers (e.g. macOS Keychain) for multi-valued keys.
/// Our helper is tried first; if it has no match, git falls through to existing helpers.
async fn prepare_credential_env(
    db: &AppDatabase,
    app_data_dir: &std::path::Path,
    terminal_id: &str,
) -> (Option<HashMap<String, String>>, Option<TerminalCredFiles>) {
    let accounts = match git_credential::load_github_accounts(&db.conn).await {
        Some(s) if !s.accounts.is_empty() => s.accounts,
        _ => return (None, None),
    };

    let cred_file = app_data_dir.join(format!("git-creds-{}.tmp", terminal_id));
    if let Err(e) = git_credential::write_credential_store_file(&accounts, &cred_file) {
        eprintln!("[TERM] failed to write credential store file: {}", e);
        return (None, None);
    }

    let helper_script = match git_credential::create_credential_helper_script(
        app_data_dir,
        &cred_file,
        terminal_id,
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[TERM] failed to create credential helper script: {}", e);
            let _ = std::fs::remove_file(&cred_file);
            return (None, None);
        }
    };

    let helper_path_str = helper_script.to_string_lossy().to_string();

    // GIT_CONFIG_COUNT adds config entries that are tried BEFORE file-based config.
    // For multi-valued keys like credential.helper, this means our helper runs first;
    // if it exits 0 with no output, git falls through to the user's existing helpers.
    let mut env = HashMap::new();
    env.insert("GIT_CONFIG_COUNT".to_string(), "1".to_string());
    env.insert(
        "GIT_CONFIG_KEY_0".to_string(),
        "credential.helper".to_string(),
    );
    env.insert(
        "GIT_CONFIG_VALUE_0".to_string(),
        helper_path_str,
    );

    let files = TerminalCredFiles {
        cred_file,
        helper_script,
    };
    (Some(env), Some(files))
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

    let (extra_env, cred_files) =
        prepare_credential_env(&db, &app_data_dir, &terminal_id).await;

    let temp_files = cred_files
        .map(|f| vec![f.cred_file, f.helper_script])
        .unwrap_or_default();

    manager.spawn_with_id(
        SpawnOptions {
            terminal_id,
            working_dir,
            owner_window_label: window.label().to_string(),
            initial_command,
            extra_env,
            temp_files,
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
