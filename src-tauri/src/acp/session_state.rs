//! 会话级状态结构。后端权威：流式累积、in-flight tool calls、待处理 permission 等
//! 全部住在这里。Phase 2 的 snapshot 端点直接从此处读取 live 部分。

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acp::types::{
    AcpEvent, AvailableCommandInfo, ConnectionStatus, PromptCapabilitiesInfo,
    SessionConfigOptionInfo, SessionModeStateInfo,
};
use crate::models::agent::AgentType;
use crate::models::message::MessageRole;

/// 当前 streaming 中的 turn 的累积内容。turn 完成后清空。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: Vec<LiveContentBlock>,
    pub started_at: DateTime<Utc>,
}

/// 流式 turn 的内容块。事件按到达顺序追加。
#[allow(dead_code)] // ToolCallRef and Plan reserved for future events (Task 2 producers)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LiveContentBlock {
    Text { text: String },
    Thinking { text: String },
    ToolCallRef { tool_call_id: String },
    Plan { entries: serde_json::Value },
}

/// 工具调用的运行态。turn 完成时统一 clear。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallState {
    pub id: String,
    pub kind: ToolKind,
    pub label: String,
    pub status: ToolCallStatus,
    pub input: Option<serde_json::Value>,
    pub output: Option<ToolCallOutput>,
    /// 流式拼接的 input chunks（serde 不输出，仅运行时用）
    #[serde(skip)]
    pub raw_input_chunks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// 工具种类。沿用 ACP 协议层枚举。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    Other,
}

/// 工具调用输出。可能是文本、错误、结构化结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolCallOutput {
    Text { content: String },
    Error { message: String },
    Json { value: serde_json::Value },
}

/// 待处理的权限请求。重连后从 SessionState 恢复，跨 UI 关闭不丢。
/// 注意：与 chat_channel::PendingPermission 不同（后者有 sent_message_id）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermissionState {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_description: String,
    pub options: Vec<crate::acp::types::PermissionOptionInfo>,
    pub created_at: DateTime<Utc>,
}

/// 上下文 / 模型用量。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageInfo {
    pub used: u64,
    pub size: u64,
}

/// 后端权威的会话状态。每个 AgentConnection 持有一个 Arc<RwLock<SessionState>>。
///
/// 字段范围：仅当前 turn 的 in-flight 数据 + 元信息 + 协商出的能力。
/// 已完成的 turn 不存在这里——它们由 parser 从 agent JSONL 读。
#[allow(dead_code)] // Phase 1 Task 2: many fields populated/read by Phase 1 Task 3 + Phase 2 endpoints
#[derive(Debug)]
pub struct SessionState {
    // 身份
    pub connection_id: String,
    pub conversation_id: Option<i64>,
    pub external_id: Option<String>,
    pub agent_type: AgentType,
    pub working_dir: Option<PathBuf>,
    pub owner_window_label: String,
    pub folder_id: Option<i64>,

    // 状态
    pub status: ConnectionStatus,
    pub live_message: Option<LiveMessage>,
    pub active_tool_calls: HashMap<String, ToolCallState>,
    pub pending_permission: Option<PendingPermissionState>,

    // ACP 协商出的能力
    pub modes: Option<SessionModeStateInfo>,
    pub current_mode: Option<String>,
    pub config_options: Option<Vec<SessionConfigOptionInfo>>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub fork_supported: bool,
    pub available_commands: Vec<AvailableCommandInfo>,
    pub usage: Option<UsageInfo>,

    // 事件锚点
    pub event_seq: u64,
    pub last_activity_at: DateTime<Utc>,
}

#[allow(dead_code)] // `to_snapshot` is consumed by Phase 2 snapshot endpoints
impl SessionState {
    pub fn new(
        connection_id: String,
        agent_type: AgentType,
        working_dir: Option<PathBuf>,
        owner_window_label: String,
        folder_id: Option<i64>,
    ) -> Self {
        Self {
            connection_id,
            conversation_id: None,
            external_id: None,
            agent_type,
            working_dir,
            owner_window_label,
            folder_id,
            status: ConnectionStatus::Connecting,
            live_message: None,
            active_tool_calls: HashMap::new(),
            pending_permission: None,
            modes: None,
            current_mode: None,
            config_options: None,
            prompt_capabilities: None,
            fork_supported: false,
            available_commands: Vec::new(),
            usage: None,
            event_seq: 0,
            last_activity_at: Utc::now(),
        }
    }

    /// 单一分发器：把一个 AcpEvent 应用到 self。注意此方法**不**自增 event_seq——
    /// seq 由 emit_with_state 在外层管理（这样 apply_event 可独立单元测试）。
    pub fn apply_event(&mut self, payload: &AcpEvent) {
        match payload {
            AcpEvent::SessionStarted { session_id } => {
                self.external_id = Some(session_id.clone());
                self.status = ConnectionStatus::Connected;
            }
            AcpEvent::StatusChanged { status } => {
                self.status = status.clone();
            }
            AcpEvent::SessionModes { modes } => {
                self.current_mode = Some(modes.current_mode_id.clone());
                self.modes = Some(modes.clone());
            }
            AcpEvent::ModeChanged { mode_id } => {
                self.current_mode = Some(mode_id.clone());
            }
            AcpEvent::SessionConfigOptions { config_options } => {
                self.config_options = Some(config_options.clone());
            }
            AcpEvent::PromptCapabilities {
                prompt_capabilities,
            } => {
                self.prompt_capabilities = Some(prompt_capabilities.clone());
            }
            AcpEvent::ForkSupported { supported } => {
                self.fork_supported = *supported;
            }
            AcpEvent::AvailableCommands { commands } => {
                self.available_commands = commands.clone();
            }
            AcpEvent::UsageUpdate { used, size } => {
                self.usage = Some(UsageInfo {
                    used: *used,
                    size: *size,
                });
            }
            AcpEvent::ContentDelta { text } => {
                self.append_text_delta(text);
            }
            AcpEvent::Thinking { text } => {
                self.append_thinking_delta(text);
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                content,
                raw_input,
                raw_output,
                ..
            } => {
                self.upsert_tool_call(
                    tool_call_id,
                    Some(kind),
                    Some(title),
                    Some(status),
                    content.as_deref(),
                    raw_input.as_deref(),
                    raw_output.as_deref(),
                );
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                title,
                status,
                content,
                raw_input,
                raw_output,
                ..
            } => {
                self.upsert_tool_call(
                    tool_call_id,
                    None,
                    title.as_deref(),
                    status.as_deref(),
                    content.as_deref(),
                    raw_input.as_deref(),
                    raw_output.as_deref(),
                );
            }
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
            } => {
                let (tc_id, tc_desc) = extract_tool_call_id_and_description(tool_call);
                self.pending_permission = Some(PendingPermissionState {
                    request_id: request_id.clone(),
                    tool_call_id: tc_id,
                    tool_description: tc_desc,
                    options: options.clone(),
                    created_at: Utc::now(),
                });
            }
            AcpEvent::TurnComplete { .. } => {
                self.live_message = None;
                self.active_tool_calls.clear();
                self.pending_permission = None;
                self.status = ConnectionStatus::Connected;
            }
            AcpEvent::PlanUpdate { .. }
            | AcpEvent::ClaudeSdkMessage { .. }
            | AcpEvent::SelectorsReady
            | AcpEvent::Error { .. } => {
                // 这些事件不直接修改 SessionState 的可见字段。
                // PlanUpdate 后续可能扩展为 live_message 内 Plan block；当前阶段保持空操作。
            }
        }
        self.last_activity_at = Utc::now();
    }

    fn append_text_delta(&mut self, text: &str) {
        if self.live_message.is_none() {
            self.live_message = Some(LiveMessage {
                id: format!("live-{}", uuid::Uuid::new_v4()),
                role: MessageRole::Assistant,
                content: Vec::new(),
                started_at: Utc::now(),
            });
        }
        let live = self.live_message.as_mut().expect("live_message just set");
        if let Some(LiveContentBlock::Text { text: existing }) = live.content.last_mut() {
            existing.push_str(text);
        } else {
            live.content.push(LiveContentBlock::Text {
                text: text.to_string(),
            });
        }
    }

    fn append_thinking_delta(&mut self, text: &str) {
        if self.live_message.is_none() {
            self.live_message = Some(LiveMessage {
                id: format!("live-{}", uuid::Uuid::new_v4()),
                role: MessageRole::Assistant,
                content: Vec::new(),
                started_at: Utc::now(),
            });
        }
        let live = self.live_message.as_mut().expect("live_message just set");
        if let Some(LiveContentBlock::Thinking { text: existing }) = live.content.last_mut() {
            existing.push_str(text);
        } else {
            live.content.push(LiveContentBlock::Thinking {
                text: text.to_string(),
            });
        }
    }

    /// Insert-or-update a tool call entry. Used by both `ToolCall` (initial) and
    /// `ToolCallUpdate` events. `kind` is `Some` only on the initial event;
    /// title/status/content/raw_input/raw_output are merged when present.
    #[allow(clippy::too_many_arguments)]
    fn upsert_tool_call(
        &mut self,
        id: &str,
        kind: Option<&str>,
        title: Option<&str>,
        status: Option<&str>,
        _content: Option<&str>,
        raw_input: Option<&str>,
        raw_output: Option<&str>,
    ) {
        let entry = self
            .active_tool_calls
            .entry(id.to_string())
            .or_insert_with(|| ToolCallState {
                id: id.to_string(),
                kind: ToolKind::Other,
                label: String::new(),
                status: ToolCallStatus::Pending,
                input: None,
                output: None,
                raw_input_chunks: Vec::new(),
            });
        if let Some(k) = kind {
            entry.kind = parse_tool_kind(k);
        }
        if let Some(t) = title {
            entry.label = t.to_string();
        }
        if let Some(s) = status {
            entry.status = parse_tool_call_status(s);
        }
        if let Some(chunk) = raw_input {
            entry.raw_input_chunks.push(chunk.to_string());
            // 后端目前发送的是已序列化的 JSON 文本（完整或正在累积）。
            // 对最新片段做尽力解析；解析失败则尝试拼接历史片段。
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(chunk) {
                entry.input = Some(value);
            } else if let Ok(value) =
                serde_json::from_str::<serde_json::Value>(&entry.raw_input_chunks.join(""))
            {
                entry.input = Some(value);
            }
        }
        if let Some(text) = raw_output {
            entry.output = Some(parse_tool_call_output_text(text));
        }
    }

    /// 拷贝出对外可见的 wire-friendly snapshot。Phase 2 snapshot 端点直接调用此方法。
    pub fn to_snapshot(&self) -> LiveSessionSnapshot {
        LiveSessionSnapshot {
            connection_id: self.connection_id.clone(),
            status: self.status.clone(),
            external_id: self.external_id.clone(),
            live_message: self.live_message.clone(),
            active_tool_calls: self.active_tool_calls.values().cloned().collect(),
            pending_permission: self.pending_permission.clone(),
            modes: self.modes.clone(),
            current_mode: self.current_mode.clone(),
            config_options: self.config_options.clone(),
            prompt_capabilities: self.prompt_capabilities.clone(),
            usage: self.usage.clone(),
            fork_supported: self.fork_supported,
            available_commands: self.available_commands.clone(),
            event_seq: self.event_seq,
        }
    }
}

/// `to_snapshot()` 的输出——前端可消费的 wire shape。
#[allow(dead_code)] // Phase 1 Task 2: consumed by Phase 2 snapshot endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveSessionSnapshot {
    pub connection_id: String,
    pub status: ConnectionStatus,
    pub external_id: Option<String>,
    pub live_message: Option<LiveMessage>,
    pub active_tool_calls: Vec<ToolCallState>,
    pub pending_permission: Option<PendingPermissionState>,
    pub modes: Option<SessionModeStateInfo>,
    pub current_mode: Option<String>,
    pub config_options: Option<Vec<SessionConfigOptionInfo>>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub usage: Option<UsageInfo>,
    pub fork_supported: bool,
    pub available_commands: Vec<AvailableCommandInfo>,
    pub event_seq: u64,
}

fn parse_tool_kind(s: &str) -> ToolKind {
    match s {
        "read" => ToolKind::Read,
        "edit" => ToolKind::Edit,
        "delete" => ToolKind::Delete,
        "move" => ToolKind::Move,
        "search" => ToolKind::Search,
        "execute" => ToolKind::Execute,
        "think" => ToolKind::Think,
        "fetch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

fn parse_tool_call_status(s: &str) -> ToolCallStatus {
    match s {
        "in_progress" => ToolCallStatus::InProgress,
        "completed" => ToolCallStatus::Completed,
        "failed" => ToolCallStatus::Failed,
        _ => ToolCallStatus::Pending,
    }
}

/// `raw_output` 是已序列化的 JSON 文本。尽力解析为结构化 JSON；解析失败时回退为
/// 文本。如果解析后的 JSON 顶层有 `"error"` 字段，提升为 `Error` 变体。
fn parse_tool_call_output_text(text: &str) -> ToolCallOutput {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => {
            if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                ToolCallOutput::Error {
                    message: err.to_string(),
                }
            } else if let Some(s) = value.as_str() {
                ToolCallOutput::Text {
                    content: s.to_string(),
                }
            } else {
                ToolCallOutput::Json { value }
            }
        }
        Err(_) => ToolCallOutput::Text {
            content: text.to_string(),
        },
    }
}

/// Permission 事件的 `tool_call` 字段是 sacp 的 ToolCall JSON。提取 id 和
/// 用于展示的描述（优先 title，其次 kind）。同时兼容 camelCase / snake_case。
fn extract_tool_call_id_and_description(tool_call: &serde_json::Value) -> (String, String) {
    let obj = tool_call.as_object();
    let id = obj
        .and_then(|o| {
            o.get("toolCallId")
                .or_else(|| o.get("tool_call_id"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string();
    let description = obj
        .and_then(|o| {
            o.get("title")
                .or_else(|| o.get("kind"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string();
    (id, description)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{
        AcpEvent, ConnectionStatus, PromptCapabilitiesInfo, SessionConfigKindInfo,
        SessionConfigOptionInfo, SessionConfigSelectInfo, SessionModeInfo, SessionModeStateInfo,
    };

    fn fresh_state() -> SessionState {
        SessionState::new(
            "conn-test".to_string(),
            AgentType::ClaudeCode,
            None,
            "win-test".to_string(),
            None,
        )
    }

    #[test]
    fn new_session_starts_with_seq_zero_and_connecting_status() {
        let s = fresh_state();
        assert_eq!(s.event_seq, 0);
        assert_eq!(s.status, ConnectionStatus::Connecting);
        assert!(s.external_id.is_none());
        assert!(s.live_message.is_none());
        assert!(s.active_tool_calls.is_empty());
        assert!(s.pending_permission.is_none());
        assert!(!s.fork_supported);
        assert!(s.available_commands.is_empty());
    }

    #[test]
    fn session_started_sets_external_id_and_connected_status() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-42".into(),
        });
        assert_eq!(s.external_id.as_deref(), Some("ext-42"));
        assert_eq!(s.status, ConnectionStatus::Connected);
    }

    #[test]
    fn content_delta_creates_live_message_then_appends() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "hello ".into(),
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "world".into(),
        });
        let live = s.live_message.as_ref().expect("live_message expected");
        assert_eq!(
            live.content.len(),
            1,
            "consecutive text deltas merge into one block"
        );
        match &live.content[0] {
            LiveContentBlock::Text { text } => assert_eq!(text, "hello world"),
            _ => panic!("expected text block"),
        }
        assert!(matches!(live.role, MessageRole::Assistant));
    }

    #[test]
    fn thinking_delta_creates_separate_block_from_text() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "T".into() });
        s.apply_event(&AcpEvent::Thinking { text: "X".into() });
        s.apply_event(&AcpEvent::ContentDelta { text: "Y".into() });
        let live = s.live_message.as_ref().unwrap();
        assert_eq!(live.content.len(), 3);
        match &live.content[0] {
            LiveContentBlock::Text { text } => assert_eq!(text, "T"),
            _ => panic!("expected text"),
        }
        match &live.content[1] {
            LiveContentBlock::Thinking { text } => assert_eq!(text, "X"),
            _ => panic!("expected thinking"),
        }
        match &live.content[2] {
            LiveContentBlock::Text { text } => assert_eq!(text, "Y"),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn tool_call_inserts_pending_entry() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "ls".into(),
            kind: "execute".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
        });
        let entry = s.active_tool_calls.get("tc-1").expect("tc-1 inserted");
        assert_eq!(entry.status, ToolCallStatus::Pending);
        assert_eq!(entry.kind, ToolKind::Execute);
        assert_eq!(entry.label, "ls");
        assert!(entry.input.is_none());
        assert!(entry.output.is_none());
    }

    #[test]
    fn tool_call_update_merges_status_and_output() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "cat foo.txt".into(),
            kind: "read".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
        });
        // raw_output text "\"file contents\"" — i.e. JSON-encoded string.
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some("\"file contents\"".into()),
            raw_output_append: None,
            locations: None,
            meta: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        assert_eq!(entry.status, ToolCallStatus::Completed);
        assert_eq!(entry.kind, ToolKind::Read);
        assert_eq!(entry.label, "cat foo.txt");
        match &entry.output {
            Some(ToolCallOutput::Text { content }) => assert_eq!(content, "file contents"),
            other => panic!("expected text output, got {:?}", other),
        }
    }

    #[test]
    fn turn_complete_clears_live_and_tool_calls_and_pending_permission() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "hi".into() });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "x".into(),
            kind: "read".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
        });
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: serde_json::json!({"toolCallId": "tc-1", "title": "danger"}),
            options: vec![],
        });
        assert!(s.live_message.is_some());
        assert!(s.pending_permission.is_some());
        assert_eq!(s.active_tool_calls.len(), 1);
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        assert!(s.live_message.is_none());
        assert!(s.active_tool_calls.is_empty());
        assert!(s.pending_permission.is_none());
        assert_eq!(s.status, ConnectionStatus::Connected);
    }

    #[test]
    fn permission_request_extracts_tool_call_id_and_description() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: serde_json::json!({
                "toolCallId": "tc-9",
                "title": "Run rm -rf /",
                "kind": "execute"
            }),
            options: vec![],
        });
        let p = s.pending_permission.as_ref().expect("permission set");
        assert_eq!(p.request_id, "p-1");
        assert_eq!(p.tool_call_id, "tc-9");
        assert_eq!(p.tool_description, "Run rm -rf /");
    }

    #[test]
    fn mode_changed_updates_current_mode_and_session_modes_seeds_state() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionModes {
            modes: SessionModeStateInfo {
                current_mode_id: "default".into(),
                available_modes: vec![SessionModeInfo {
                    id: "default".into(),
                    name: "Default".into(),
                    description: None,
                }],
            },
        });
        assert_eq!(s.current_mode.as_deref(), Some("default"));
        assert!(s.modes.is_some());
        s.apply_event(&AcpEvent::ModeChanged {
            mode_id: "edit".into(),
        });
        assert_eq!(s.current_mode.as_deref(), Some("edit"));
    }

    #[test]
    fn snapshot_excludes_internal_chunk_buffers_and_carries_negotiated_caps() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PromptCapabilities {
            prompt_capabilities: PromptCapabilitiesInfo {
                image: true,
                audio: false,
                embedded_context: true,
            },
        });
        s.apply_event(&AcpEvent::ForkSupported { supported: true });
        s.apply_event(&AcpEvent::SessionConfigOptions {
            config_options: vec![SessionConfigOptionInfo {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: None,
                kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                    current_value: "sonnet".into(),
                    options: vec![],
                    groups: vec![],
                }),
            }],
        });
        s.apply_event(&AcpEvent::UsageUpdate {
            used: 1234,
            size: 200_000,
        });
        // Two raw_input fragments; the second is a complete JSON object
        // and should overwrite `entry.input` with the parsed value.
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "edit".into(),
            kind: "edit".into(),
            status: "pending".into(),
            content: None,
            raw_input: Some("{\"a\":".into()),
            raw_output: None,
            locations: None,
            meta: None,
        });
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: None,
            content: None,
            raw_input: Some("{\"a\":1}".into()),
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        assert_eq!(entry.input, Some(serde_json::json!({"a": 1})));
        assert_eq!(entry.raw_input_chunks.len(), 2);

        let snapshot = s.to_snapshot();
        assert_eq!(snapshot.connection_id, "conn-test");
        assert!(snapshot.fork_supported);
        assert_eq!(
            snapshot.usage,
            Some(UsageInfo {
                used: 1234,
                size: 200_000,
            })
        );
        assert!(snapshot.prompt_capabilities.is_some());
        assert_eq!(snapshot.config_options.as_ref().map(|v| v.len()), Some(1));
        assert_eq!(snapshot.active_tool_calls.len(), 1);

        // Wire shape: raw_input_chunks must NOT be serialized.
        let json = serde_json::to_value(&snapshot).unwrap();
        let tc_json = json["active_tool_calls"][0].clone();
        assert!(
            tc_json.get("raw_input_chunks").is_none(),
            "raw_input_chunks must be #[serde(skip)] (got {})",
            tc_json
        );
        assert_eq!(tc_json["input"], serde_json::json!({"a": 1}));
    }
}
