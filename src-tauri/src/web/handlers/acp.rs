use axum::{extract::Extension, Json};
use serde::Deserialize;
use tauri::Manager;

use crate::acp::manager::ConnectionManager;
use crate::acp::registry;
use crate::acp::types::{AcpAgentInfo, AcpAgentStatus};
use crate::app_error::AppCommandError;
use crate::commands::acp as acp_commands;
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTypeParams {
    pub agent_type: AgentType,
}

pub async fn acp_get_agent_status(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AgentTypeParams>,
) -> Result<Json<AcpAgentStatus>, AppCommandError> {
    let db = app.state::<crate::db::AppDatabase>();
    let result = acp_commands::acp_get_agent_status(params.agent_type, db)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

pub async fn acp_list_agents(
    Extension(app): Extension<tauri::AppHandle>,
) -> Result<Json<Vec<AcpAgentInfo>>, AppCommandError> {
    let db = app.state::<crate::db::AppDatabase>();
    let result = acp_commands::acp_list_agents(db)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpConnectParams {
    pub agent_type: AgentType,
    pub working_dir: Option<String>,
    pub session_id: Option<String>,
}

pub async fn acp_connect(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AcpConnectParams>,
) -> Result<Json<String>, AppCommandError> {
    let db = app.state::<AppDatabase>();
    let manager = app.state::<ConnectionManager>();
    let meta = registry::get_agent_meta(params.agent_type);

    let setting = agent_setting_service::get_by_agent_type(&db.conn, params.agent_type)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    let disabled = setting
        .as_ref()
        .map(|model| !model.enabled)
        .unwrap_or(false);
    if disabled {
        return Err(AppCommandError::task_execution_failed(format!(
            "{} is disabled in settings",
            params.agent_type
        )));
    }

    let local_config_json = acp_commands::load_agent_local_config_json(params.agent_type);
    let mut runtime_env = acp_commands::build_runtime_env_from_setting(
        params.agent_type,
        setting.as_ref(),
        local_config_json.as_deref(),
    );

    if params.agent_type == AgentType::OpenClaw && params.session_id.is_none() {
        runtime_env.insert("OPENCLAW_RESET_SESSION".into(), "1".into());
    }

    if let registry::AgentDistribution::Npx { cmd, .. } = meta.distribution {
        if !acp_commands::is_cmd_available(cmd) {
            return Err(AppCommandError::task_execution_failed(format!(
                "{} SDK is not installed. Please install it in Agent Settings.",
                meta.name
            )));
        }
    }

    let connection_id = manager
        .spawn_agent(
            params.agent_type,
            params.working_dir,
            params.session_id,
            runtime_env,
            "web".to_string(),
            app.clone(),
        )
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    Ok(Json(connection_id))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpDisconnectParams {
    pub connection_id: String,
}

pub async fn acp_disconnect(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AcpDisconnectParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = app.state::<ConnectionManager>();
    manager
        .disconnect(&params.connection_id)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptParams {
    pub connection_id: String,
    pub blocks: Vec<crate::acp::types::PromptInputBlock>,
}

pub async fn acp_prompt(
    Extension(app): Extension<tauri::AppHandle>,
    Json(params): Json<AcpPromptParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = app.state::<ConnectionManager>();
    manager
        .send_prompt(&params.connection_id, params.blocks)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}
