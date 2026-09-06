//! HTTP handlers for the codeg-mcp service status indicator — the web-mode
//! mirror of the Tauri commands in `commands::mcp_service`.
//!
//! Both transports call the same `_core` helpers, so the probe, the state
//! ladder and the rebind behave identically whether the workspace is running
//! in the desktop shell or against a remote `codeg-server`.

use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::mcp_service::{
    codeg_mcp_service_status_core, start_codeg_mcp_service_core, CodegMcpServiceStatus,
    CodegMcpStatusSources,
};

pub async fn get_codeg_mcp_service_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CodegMcpServiceStatus>, AppCommandError> {
    Ok(Json(
        codeg_mcp_service_status_core(CodegMcpStatusSources {
            broker: &state.delegation_broker,
            tokens: &state.delegation_tokens,
            feedback: &state.feedback_config,
            question: &state.question_config,
            session_info: &state.session_info_config,
            authoring: &state.chat_authoring_config,
        })
        .await,
    ))
}

pub async fn start_codeg_mcp_service() -> Result<Json<()>, AppCommandError> {
    start_codeg_mcp_service_core().await?;
    Ok(Json(()))
}
