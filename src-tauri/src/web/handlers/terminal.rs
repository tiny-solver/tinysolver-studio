use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::app_error::AppCommandError;
use crate::commands::terminal::prepare_credential_env;
use crate::terminal::manager::{SpawnOptions, TerminalManager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnParams {
    pub working_dir: String,
    pub initial_command: Option<String>,
}

pub async fn terminal_spawn(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<TerminalSpawnParams>,
) -> Result<Json<String>, AppCommandError> {
    let manager = app.state::<TerminalManager>();
    let terminal_id = uuid::Uuid::new_v4().to_string();

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    let extra_env = prepare_credential_env(&app_data_dir);

    let id = manager
        .spawn_with_id(
            SpawnOptions {
                terminal_id,
                working_dir: params.working_dir,
                owner_window_label: "web".to_string(),
                initial_command: params.initial_command,
                extra_env,
                temp_files: vec![],
            },
            app.clone(),
        )
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    Ok(Json(id))
}
