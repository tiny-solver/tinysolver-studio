use std::collections::HashMap;

use tauri::Manager;
use tauri::State;

use crate::git_credential;
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{SpawnOptions, TerminalManager};
use crate::terminal::types::TerminalInfo;

/// Build extra env vars for the terminal session.
///
/// Uses `credential.helper` with a script that calls the app binary with
/// `--credential-helper`. The binary opens the DB, looks up the matching
/// account, and outputs credentials. No credentials are written to disk.
pub(crate) fn prepare_credential_env(
    app_data_dir: &std::path::Path,
) -> Option<HashMap<String, String>> {
    // Get the path to the current running binary
    let app_binary = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[TERM] failed to get current exe path: {}", e);
            return None;
        }
    };

    let helper_script = match git_credential::create_credential_helper_script(
        app_data_dir,
        &app_binary,
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[TERM] failed to create credential helper script: {}", e);
            return None;
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
    // The '!' prefix tells git to run as a raw shell command (not git-credential-<name>).
    // Paths with spaces (e.g. "Application Support") must be quoted.
    env.insert(
        "GIT_CONFIG_VALUE_0".to_string(),
        format!("!\"{}\"", helper_path_str),
    );

    Some(env)
}

#[tauri::command]
pub async fn terminal_spawn(
    working_dir: String,
    initial_command: Option<String>,
    manager: State<'_, TerminalManager>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, TerminalError> {
    let terminal_id = uuid::Uuid::new_v4().to_string();

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

    let extra_env = prepare_credential_env(&app_data_dir);

    manager.spawn_with_id(
        SpawnOptions {
            terminal_id,
            working_dir,
            owner_window_label: window.label().to_string(),
            initial_command,
            extra_env,
            temp_files: vec![],
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
