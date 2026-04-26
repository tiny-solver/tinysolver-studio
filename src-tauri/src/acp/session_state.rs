//! 会话级状态结构。后端权威：流式累积、in-flight tool calls、待处理 permission 等
//! 全部住在这里。Phase 2 的 snapshot 端点直接从此处读取 live 部分。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::models::message::MessageRole;

/// 当前 streaming 中的 turn 的累积内容。turn 完成后清空。
#[allow(dead_code)] // Constructed by Task 2 SessionState event handlers
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
#[allow(dead_code)] // Constructed by Task 2 SessionState event handlers
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

#[allow(dead_code)] // Variants populated by Task 2 event handlers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// 工具种类。沿用 ACP 协议层枚举。
#[allow(dead_code)] // Variants populated by Task 2 event handlers
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
#[allow(dead_code)] // Error and Json variants reserved for Task 2 event handlers
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolCallOutput {
    Text { content: String },
    Error { message: String },
    Json { value: serde_json::Value },
}

/// 待处理的权限请求。重连后从 SessionState 恢复，跨 UI 关闭不丢。
/// 注意：与 chat_channel::PendingPermission 不同（后者有 sent_message_id）。
#[allow(dead_code)] // Constructed by Task 2 SessionState event handlers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermissionState {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_description: String,
    pub options: Vec<crate::acp::types::PermissionOptionInfo>,
    pub created_at: DateTime<Utc>,
}

/// 上下文 / 模型用量。
#[allow(dead_code)] // Constructed by Task 2 SessionState event handlers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageInfo {
    pub used: u64,
    pub size: u64,
}
