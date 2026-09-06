//! Health report for the codeg-mcp service, and the one action that can fix
//! it from the UI.
//!
//! "The codeg-mcp service" is really three things stacked, and a session loses
//! its codeg tools if ANY of them is missing:
//!
//!   1. the **companion binary** on disk — `codeg-mcp`, which the agent CLI
//!      spawns as a stdio MCP server (see `acp::connection::inject_codeg_mcp`);
//!   2. the **broker socket** inside this process, which every companion
//!      round-trips through (see `acp::delegation::service`);
//!   3. at least one **enabled tool group** — with all of them off, injection
//!      short-circuits before it even looks for the binary.
//!
//! Each fails differently and each is invisible today: a missing binary logs
//! one line at spawn time, a dead socket logs nothing at all, and "everything
//! is off in settings" looks identical to both from a conversation. This
//! module collapses the three into one [`CodegMcpServiceStatus`] the status-bar
//! indicator renders, with a single headline [`CodegMcpServiceState`] so the
//! popover can offer exactly one next step.
//!
//! Only #2 is startable from here — #1 needs a reinstall and #3 is a settings
//! write the frontend already owns.

// Only the Tauri command signatures (and the tests) name `Arc` directly; the
// `_core` helpers take plain references so both transports can share them.
#[cfg(any(test, feature = "tauri-runtime"))]
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::acp::chat_authoring::ChatAuthoringRuntimeConfig;
use crate::acp::delegation::broker::DelegationBroker;
use crate::acp::delegation::listener::TokenRegistry;
use crate::acp::delegation::service;
use crate::acp::feedback::FeedbackRuntimeConfig;
use crate::acp::question::QuestionRuntimeConfig;
use crate::acp::session_info::SessionInfoRuntimeConfig;
use crate::app_error::AppCommandError;

/// Headline verdict. Ordered by which problem to solve first, not by severity:
/// the socket is the only piece this process can repair, so it outranks a
/// missing binary even though that one is more fundamental. Everything the
/// state hides is still reported field-by-field alongside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodegMcpServiceState {
    /// The broker socket isn't answering. Companions would launch and fail to
    /// reach codeg. Fixable here — see [`start_codeg_mcp_service_core`].
    Stopped,
    /// The socket is fine but the `codeg-mcp` binary isn't on disk, so nothing
    /// gets injected into an agent's MCP config. Needs a reinstall or
    /// `CODEG_MCP_BIN`; there is nothing to start.
    Unavailable,
    /// Everything is in place, but every tool group is switched off, so no
    /// companion is injected. Fixed in settings, not here.
    Disabled,
    /// Socket answering, binary present, at least one tool group live.
    Running,
}

/// One toggleable tool group, named by the `--features` slug the companion
/// parses. Sent as a list rather than a struct of bools so the popover can
/// render whatever the backend currently supports without a lockstep frontend
/// change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodegMcpToolGroup {
    pub key: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodegMcpServiceStatus {
    pub state: CodegMcpServiceState,
    /// Whether the broker socket answered a liveness ping just now.
    pub listening: bool,
    /// UDS path (unix) or named-pipe name (Windows) the companions dial.
    pub socket_path: String,
    /// Resolved `codeg-mcp` path, or `None` when the lookup came up empty.
    pub binary_path: Option<String>,
    /// Tool groups and their current switches, in companion `--features` order.
    pub tool_groups: Vec<CodegMcpToolGroup>,
    /// Companions currently holding a valid token, and how many distinct agent
    /// sessions they belong to.
    pub companion_count: u32,
    pub session_count: u32,
    /// Delegations parked on a child's turn right now.
    pub active_delegations: u32,
    /// Delegation chain depth ceiling, echoed so the popover doesn't need a
    /// second round trip to explain a refused `delegate_to_agent`.
    pub depth_limit: u32,
    /// Unix millis of the bind that produced the current accept loop.
    pub started_at: Option<i64>,
    /// Why the last bind attempt failed, when one did.
    pub last_error: Option<String>,
    /// Whether this process holds a service handle at all. `false` in runtimes
    /// that never bound a socket — the UI must hide the start button rather
    /// than offer one that can only fail.
    pub can_start: bool,
}

/// The runtime pieces a status report reads. Bundled into one struct because
/// they arrive from different places in each runtime (Tauri managed state vs
/// `AppState` fields) and seven positional `&` arguments of similar type is a
/// silent argument-swap waiting to happen.
pub struct CodegMcpStatusSources<'a> {
    pub broker: &'a DelegationBroker,
    pub tokens: &'a TokenRegistry,
    pub feedback: &'a FeedbackRuntimeConfig,
    pub question: &'a QuestionRuntimeConfig,
    pub session_info: &'a SessionInfoRuntimeConfig,
    pub authoring: &'a ChatAuthoringRuntimeConfig,
}

/// Build the report. Probes the socket for real (one ping round-trip), so
/// callers should treat this as a network-ish call, not a field read.
pub async fn codeg_mcp_service_status_core(
    sources: CodegMcpStatusSources<'_>,
) -> CodegMcpServiceStatus {
    let handle = service::current();
    // Without an installed handle there is no socket to probe and no way to
    // start one; report the configured path so the popover can still name what
    // it is talking about.
    let socket_path = handle
        .as_ref()
        .map(|s| s.socket_path().to_string_lossy().to_string())
        .unwrap_or_default();
    let listening = match handle.as_ref() {
        Some(s) => s.is_listening().await,
        None => false,
    };
    let snapshot = match handle.as_ref() {
        Some(s) => s.snapshot().await,
        None => Default::default(),
    };

    let binary_path = crate::acp::connection::locate_codeg_mcp_binary()
        .map(|p| p.to_string_lossy().to_string());

    let delegation_cfg = sources.broker.config_snapshot().await;
    let authoring_cfg = sources.authoring.snapshot().await;
    // Same order the companion's `CompanionFeatures::parse` recognizes. `tasks`
    // is deliberately absent: it is a per-spawn flag on task-engine launches,
    // not a setting anyone can toggle, so listing it here would invite the user
    // to look for a switch that doesn't exist.
    let tool_groups = vec![
        CodegMcpToolGroup {
            key: "delegation".into(),
            enabled: delegation_cfg.enabled,
        },
        CodegMcpToolGroup {
            key: "feedback".into(),
            enabled: sources.feedback.is_enabled().await,
        },
        CodegMcpToolGroup {
            key: "ask".into(),
            enabled: sources.question.is_enabled().await,
        },
        CodegMcpToolGroup {
            key: "sessions".into(),
            enabled: sources.session_info.is_enabled().await,
        },
        CodegMcpToolGroup {
            key: "automations".into(),
            enabled: authoring_cfg.automations_enabled,
        },
        CodegMcpToolGroup {
            key: "taskboard".into(),
            enabled: authoring_cfg.work_tasks_enabled,
        },
    ];
    let any_group_enabled = tool_groups.iter().any(|g| g.enabled);

    let state = if !listening {
        CodegMcpServiceState::Stopped
    } else if binary_path.is_none() {
        CodegMcpServiceState::Unavailable
    } else if !any_group_enabled {
        CodegMcpServiceState::Disabled
    } else {
        CodegMcpServiceState::Running
    };

    let token_stats = sources.tokens.stats().await;
    CodegMcpServiceStatus {
        state,
        listening,
        socket_path,
        binary_path,
        tool_groups,
        companion_count: token_stats.companions as u32,
        session_count: token_stats.parent_connections as u32,
        active_delegations: sources.broker.running_delegation_count().await as u32,
        depth_limit: delegation_cfg.depth_limit,
        started_at: snapshot.started_at,
        last_error: snapshot.last_error,
        can_start: handle.is_some(),
    }
}

/// Bind the broker socket if it isn't already answering. Idempotent — a click
/// on an already-healthy service is a no-op success, not an error, because the
/// UI's view of "stopped" can be a probe or two out of date.
pub async fn start_codeg_mcp_service_core() -> Result<(), AppCommandError> {
    let Some(handle) = service::current() else {
        return Err(AppCommandError::configuration_invalid(
            "codeg-mcp broker socket is not managed by this process",
        ));
    };
    handle
        .ensure_running()
        .await
        .map_err(AppCommandError::configuration_invalid)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_codeg_mcp_service_status(
    #[cfg(feature = "tauri-runtime")] broker: tauri::State<'_, Arc<DelegationBroker>>,
    #[cfg(feature = "tauri-runtime")] tokens: tauri::State<'_, Arc<TokenRegistry>>,
    #[cfg(feature = "tauri-runtime")] feedback: tauri::State<'_, FeedbackRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] question: tauri::State<'_, QuestionRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] session_info: tauri::State<'_, SessionInfoRuntimeConfig>,
    #[cfg(feature = "tauri-runtime")] authoring: tauri::State<'_, ChatAuthoringRuntimeConfig>,
) -> Result<CodegMcpServiceStatus, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(codeg_mcp_service_status_core(CodegMcpStatusSources {
            broker: broker.inner(),
            tokens: tokens.inner(),
            feedback: feedback.inner(),
            question: question.inner(),
            session_info: session_info.inner(),
            authoring: authoring.inner(),
        })
        .await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        // Server mode reaches this via the web handler, not this command.
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_codeg_mcp_service() -> Result<(), AppCommandError> {
    start_codeg_mcp_service_core().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::chat_authoring::ChatAuthoringConfig;
    use crate::acp::delegation::broker::{
        ConversationDepthLookup, DelegationBroker, DelegationConfig,
    };
    use crate::acp::delegation::listener::TokenEntry;
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::DelegationError;
    use crate::acp::feedback::FeedbackConfig;
    use async_trait::async_trait;

    struct NoParent;
    #[async_trait]
    impl ConversationDepthLookup for NoParent {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    struct Fixture {
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        feedback: FeedbackRuntimeConfig,
        question: QuestionRuntimeConfig,
        session_info: SessionInfoRuntimeConfig,
        authoring: ChatAuthoringRuntimeConfig,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                broker: Arc::new(DelegationBroker::new(
                    Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
                    Arc::new(NoParent) as Arc<dyn ConversationDepthLookup>,
                )),
                tokens: Arc::new(TokenRegistry::default()),
                feedback: FeedbackRuntimeConfig::new(),
                question: QuestionRuntimeConfig::new(),
                session_info: SessionInfoRuntimeConfig::new(),
                authoring: ChatAuthoringRuntimeConfig::new(),
            }
        }

        fn sources(&self) -> CodegMcpStatusSources<'_> {
            CodegMcpStatusSources {
                broker: &self.broker,
                tokens: &self.tokens,
                feedback: &self.feedback,
                question: &self.question,
                session_info: &self.session_info,
                authoring: &self.authoring,
            }
        }

        async fn status(&self) -> CodegMcpServiceStatus {
            codeg_mcp_service_status_core(self.sources()).await
        }
    }

    /// No service handle is installed in unit tests, so every report here is
    /// the "socket down" branch — which is exactly the case that must never
    /// offer a start button it cannot honor.
    #[tokio::test]
    async fn reports_stopped_and_unstartable_without_an_installed_handle() {
        let f = Fixture::new();
        let status = f.status().await;
        assert_eq!(status.state, CodegMcpServiceState::Stopped);
        assert!(!status.listening);
        assert!(!status.can_start);
        assert!(start_codeg_mcp_service_core().await.is_err());
    }

    /// The socket verdict outranks the tool switches: turning every group on
    /// cannot make a dead socket read as running.
    #[tokio::test]
    async fn enabled_groups_do_not_override_a_dead_socket() {
        let f = Fixture::new();
        f.broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;
        f.feedback.set(FeedbackConfig { enabled: true }).await;
        assert_eq!(f.status().await.state, CodegMcpServiceState::Stopped);
    }

    #[tokio::test]
    async fn tool_groups_mirror_the_live_switches() {
        let f = Fixture::new();
        f.broker
            .set_config(DelegationConfig {
                enabled: true,
                depth_limit: 5,
                ..DelegationConfig::default()
            })
            .await;
        f.authoring
            .set(ChatAuthoringConfig {
                automations_enabled: true,
                work_tasks_enabled: false,
            })
            .await;

        let status = f.status().await;
        let group = |key: &str| {
            status
                .tool_groups
                .iter()
                .find(|g| g.key == key)
                .unwrap_or_else(|| panic!("missing group {key}"))
                .enabled
        };
        assert!(group("delegation"));
        assert!(group("automations"));
        assert!(!group("taskboard"));
        assert_eq!(status.depth_limit, 5);
        // `tasks` is per-spawn, never a switch — it must not appear.
        assert!(status.tool_groups.iter().all(|g| g.key != "tasks"));
    }

    /// Two companions on one connection is one session, not two — the popover
    /// counts agent sessions, and re-injection can leave an old token behind.
    #[tokio::test]
    async fn counts_companions_and_distinct_sessions() {
        let f = Fixture::new();
        for token in ["t1", "t2"] {
            f.tokens
                .register(
                    token.into(),
                    TokenEntry {
                        parent_connection_id: "conn-a".into(),
                        working_dir: std::path::PathBuf::from("/tmp"),
                    },
                )
                .await;
        }
        f.tokens
            .register(
                "t3".into(),
                TokenEntry {
                    parent_connection_id: "conn-b".into(),
                    working_dir: std::path::PathBuf::from("/tmp"),
                },
            )
            .await;

        let status = f.status().await;
        assert_eq!(status.companion_count, 3);
        assert_eq!(status.session_count, 2);
    }
}
