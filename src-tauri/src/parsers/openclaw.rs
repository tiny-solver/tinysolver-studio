use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, TimeZone, Utc};
use regex::Regex;
use serde::Deserialize;

use crate::models::*;
use crate::parsers::{
    compute_session_stats, folder_name_from_path, infer_context_window_max_tokens,
    latest_turn_total_usage_tokens, merge_context_window_stats, truncate_str, AgentParser,
    ParseError,
};

/// Regex to strip the "Sender (untrusted metadata):" block and optional
/// timestamp prefix from OpenClaw user messages.
fn sender_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)^Sender \(untrusted metadata\):\s*```[^`]*```\s*").unwrap()
    })
}

fn timestamp_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[.*?\]\s*").unwrap())
}

fn working_dir_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[Working directory:[^\]]*\]\s*").unwrap())
}

/// Regex to extract the working directory path from a user message prefix.
fn working_dir_extract_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[Working directory:\s*([^\]]+)\]").unwrap())
}

/// Extract the working directory from OpenClaw user message text.
/// Returns the expanded path (~ replaced with home dir).
fn extract_working_dir(text: &str) -> Option<String> {
    let captures = working_dir_extract_regex().captures(text)?;
    let raw_path = captures.get(1)?.as_str().trim();
    if raw_path.is_empty() {
        return None;
    }
    // Expand ~ to home directory
    if let Some(stripped) = raw_path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return Some(home.join(stripped).to_string_lossy().to_string());
        }
    }
    Some(raw_path.to_string())
}

/// Strip OpenClaw user message prefix metadata.
fn strip_openclaw_user_prefix(text: &str) -> String {
    let cleaned = sender_block_regex().replace(text, "");
    let cleaned = timestamp_prefix_regex().replace(&cleaned, "");
    let cleaned = working_dir_prefix_regex().replace(&cleaned, "");
    cleaned.trim().to_string()
}

// ── sessions.json deserialization ──────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    session_id: String,
    updated_at: Option<u64>,
    model: Option<String>,
    context_tokens: Option<u64>,
    #[allow(dead_code)]
    input_tokens: Option<u64>,
    #[allow(dead_code)]
    output_tokens: Option<u64>,
    #[allow(dead_code)]
    cache_read: Option<u64>,
    #[allow(dead_code)]
    cache_write: Option<u64>,
    #[allow(dead_code)]
    total_tokens: Option<u64>,
    origin: Option<SessionOrigin>,
}

#[derive(Deserialize)]
struct SessionOrigin {
    label: Option<String>,
}

// ── Parser ─────────────────────────────────────────────────────────────

pub struct OpenClawParser {
    base_dir: PathBuf,
}

impl OpenClawParser {
    pub fn new() -> Self {
        let base_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".openclaw")
            .join("agents");
        Self { base_dir }
    }

    /// Read sessions.json for a given agent directory.
    fn read_session_index(
        agent_dir: &Path,
    ) -> Result<HashMap<String, SessionMeta>, ParseError> {
        let index_path = agent_dir.join("sessions").join("sessions.json");
        if !index_path.exists() {
            return Ok(HashMap::new());
        }
        let content = fs::read_to_string(&index_path)?;
        let index: HashMap<String, SessionMeta> = serde_json::from_str(&content)?;
        Ok(index)
    }

    /// Parse a JSONL file to extract summary information.
    fn parse_jsonl_summary(
        agent_id: &str,
        session_meta: &SessionMeta,
        jsonl_path: &PathBuf,
    ) -> Result<Option<ConversationSummary>, ParseError> {
        let file = fs::File::open(jsonl_path)?;
        let reader = BufReader::new(file);

        let mut cwd: Option<String> = None;
        let mut title: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;
        let mut message_count: u32 = 0;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            // Extract timestamp from any record
            if let Some(ts) = parse_iso_timestamp(&value) {
                if first_timestamp.is_none() {
                    first_timestamp = Some(ts);
                }
                last_timestamp = Some(ts);
            }

            match record_type {
                "session" => {
                    if cwd.is_none() {
                        cwd = value
                            .get("cwd")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                    }
                }
                "message" => {
                    let role = value
                        .get("message")
                        .and_then(|m| m.get("role"))
                        .and_then(|r| r.as_str())
                        .unwrap_or("");

                    match role {
                        "user" => {
                            message_count += 1;
                            if let Some(text) = extract_first_text_content(&value) {
                                // Extract working directory from user message
                                // (overrides session cwd with the latest project dir)
                                if let Some(wd) = extract_working_dir(&text) {
                                    cwd = Some(wd);
                                }
                                if title.is_none() {
                                    let cleaned = strip_openclaw_user_prefix(&text);
                                    if !cleaned.is_empty() {
                                        title = Some(truncate_str(&cleaned, 100));
                                    }
                                }
                            }
                        }
                        "assistant" => {
                            message_count += 1;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }

        let started_at = match first_timestamp {
            Some(ts) => ts,
            None => return Ok(None),
        };

        // Use updatedAt from sessions.json as ended_at if available
        let ended_at = session_meta
            .updated_at
            .and_then(|ms| Utc.timestamp_millis_opt(ms as i64).single())
            .or(last_timestamp);

        // Use origin.label as title fallback
        if title.is_none() {
            title = session_meta
                .origin
                .as_ref()
                .and_then(|o| o.label.clone());
        }

        let conversation_id = format!("{}/{}", agent_id, session_meta.session_id);
        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        Ok(Some(ConversationSummary {
            id: conversation_id,
            agent_type: AgentType::OpenClaw,
            folder_path,
            folder_name,
            title,
            started_at,
            ended_at,
            message_count,
            model: session_meta.model.clone(),
            git_branch: None,
        }))
    }

    /// Parse a JSONL file to extract full conversation detail.
    fn parse_conversation_detail(
        jsonl_path: &PathBuf,
        conversation_id: &str,
        session_meta: Option<&SessionMeta>,
    ) -> Result<ConversationDetail, ParseError> {
        let file = fs::File::open(jsonl_path)?;
        let reader = BufReader::new(file);

        let mut messages: Vec<UnifiedMessage> = Vec::new();
        let mut cwd: Option<String> = None;
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            if let Some(ts) = parse_iso_timestamp(&value) {
                if first_timestamp.is_none() {
                    first_timestamp = Some(ts);
                }
                last_timestamp = Some(ts);
            }

            match record_type {
                "session" => {
                    if cwd.is_none() {
                        cwd = value
                            .get("cwd")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                    }
                }
                "message" => {
                    let role = value
                        .get("message")
                        .and_then(|m| m.get("role"))
                        .and_then(|r| r.as_str())
                        .unwrap_or("");

                    let timestamp = parse_iso_timestamp(&value).unwrap_or_else(Utc::now);
                    let msg_id = value
                        .get("id")
                        .and_then(|i| i.as_str())
                        .unwrap_or("")
                        .to_string();

                    match role {
                        "user" => {
                            // Extract working directory from raw text before cleaning
                            if let Some(raw_text) = extract_first_text_content(&value) {
                                if let Some(wd) = extract_working_dir(&raw_text) {
                                    cwd = Some(wd);
                                }
                            }

                            let content = extract_user_content(&value);
                            if content.is_empty() {
                                continue;
                            }

                            if title.is_none() {
                                if let Some(ContentBlock::Text { ref text }) = content.first() {
                                    title = Some(truncate_str(text, 100));
                                }
                            }

                            messages.push(UnifiedMessage {
                                id: msg_id,
                                role: MessageRole::User,
                                content,
                                timestamp,
                                usage: None,
                                duration_ms: None,
                                model: None,
                            });
                        }
                        "assistant" => {
                            let content = extract_assistant_content(&value);
                            let usage = extract_usage(&value);
                            let msg_model = value
                                .get("message")
                                .and_then(|m| m.get("model"))
                                .and_then(|m| m.as_str())
                                .map(|s| s.to_string());

                            if model.is_none() {
                                model = msg_model.clone();
                            }

                            messages.push(UnifiedMessage {
                                id: msg_id,
                                role: MessageRole::Assistant,
                                content,
                                timestamp,
                                usage,
                                duration_ms: None,
                                model: msg_model,
                            });
                        }
                        "toolResult" => {
                            let content = extract_tool_result_content(&value);
                            messages.push(UnifiedMessage {
                                id: msg_id,
                                role: MessageRole::Tool,
                                content,
                                timestamp,
                                usage: None,
                                duration_ms: None,
                                model: None,
                            });
                        }
                        _ => {}
                    }
                }
                // Skip thinking_level_change, custom, etc.
                _ => {}
            }
        }

        // Prefer model from sessions.json metadata
        if let Some(meta) = session_meta {
            if model.is_none() {
                model = meta.model.clone();
            }
        }

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        let turns = group_into_turns(messages);

        // Context window stats
        let context_window_used_tokens = latest_turn_total_usage_tokens(&turns);
        let context_window_max_tokens = session_meta
            .and_then(|m| m.context_tokens)
            .or_else(|| infer_context_window_max_tokens(model.as_deref()));
        let session_stats = merge_context_window_stats(
            compute_session_stats(&turns),
            context_window_used_tokens,
            context_window_max_tokens,
        );

        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::OpenClaw,
            folder_path,
            folder_name,
            title,
            started_at: first_timestamp.unwrap_or_else(Utc::now),
            ended_at: last_timestamp,
            message_count: turns.len() as u32,
            model,
            git_branch: None,
        };

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
        })
    }

    /// Resolve JSONL path and optional session metadata from a compound conversation ID.
    fn resolve_session(
        &self,
        conversation_id: &str,
    ) -> Result<(PathBuf, Option<SessionMeta>), ParseError> {
        if let Some((agent_id, session_id)) = conversation_id.split_once('/') {
            let agent_dir = self.base_dir.join(agent_id);
            let jsonl_path = agent_dir
                .join("sessions")
                .join(format!("{}.jsonl", session_id));

            if jsonl_path.exists() {
                // Try to load session metadata
                let meta = Self::read_session_index(&agent_dir)
                    .ok()
                    .and_then(|index| {
                        index
                            .into_values()
                            .find(|m| m.session_id == session_id)
                    });
                return Ok((jsonl_path, meta));
            }
        }

        // Fallback: scan all agent directories
        if self.base_dir.exists() {
            let session_id = conversation_id
                .split_once('/')
                .map(|(_, s)| s)
                .unwrap_or(conversation_id);

            for entry in fs::read_dir(&self.base_dir)? {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let agent_dir = entry.path();
                if !agent_dir.is_dir() {
                    continue;
                }

                // Try direct session ID (without agent prefix)
                let jsonl_path = agent_dir
                    .join("sessions")
                    .join(format!("{}.jsonl", session_id));
                if jsonl_path.exists() {
                    let meta = Self::read_session_index(&agent_dir)
                        .ok()
                        .and_then(|index| {
                            index
                                .into_values()
                                .find(|m| m.session_id == session_id)
                        });
                    return Ok((jsonl_path, meta));
                }

                // Fallback: the external_id may be an ACP session ID that differs
                // from the internal JSONL session ID.  Scan sessions.json entries
                // and return the one whose JSONL file exists and whose updatedAt is
                // closest to what the ACP connection would have created.
                if let Ok(index) = Self::read_session_index(&agent_dir) {
                    // Find the session with the most recent updatedAt whose file exists
                    let mut best: Option<(PathBuf, SessionMeta, u64)> = None;
                    for meta in index.into_values() {
                        let candidate = agent_dir
                            .join("sessions")
                            .join(format!("{}.jsonl", meta.session_id));
                        if !candidate.exists() {
                            continue;
                        }
                        let updated = meta.updated_at.unwrap_or(0);
                        if best.as_ref().map_or(true, |(_, _, t)| updated > *t) {
                            best = Some((candidate, meta, updated));
                        }
                    }
                    if let Some((path, meta, _)) = best {
                        return Ok((path, Some(meta)));
                    }
                }
            }
        }

        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

impl AgentParser for OpenClawParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();

        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        for entry in fs::read_dir(&self.base_dir)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let agent_dir = entry.path();
            if !agent_dir.is_dir() {
                continue;
            }

            let agent_id = agent_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let index = match Self::read_session_index(&agent_dir) {
                Ok(idx) => idx,
                Err(_) => continue,
            };

            for meta in index.values() {
                let jsonl_path = agent_dir
                    .join("sessions")
                    .join(format!("{}.jsonl", meta.session_id));
                if !jsonl_path.exists() {
                    continue;
                }

                match Self::parse_jsonl_summary(&agent_id, meta, &jsonl_path) {
                    Ok(Some(summary)) => conversations.push(summary),
                    Ok(None) => continue,
                    Err(_) => continue,
                }
            }
        }

        conversations.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let (jsonl_path, meta) = self.resolve_session(conversation_id)?;
        Self::parse_conversation_detail(&jsonl_path, conversation_id, meta.as_ref())
    }
}

// ── Helper functions ───────────────────────────────────────────────────

fn parse_iso_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

fn extract_first_text_content(value: &serde_json::Value) -> Option<String> {
    let content = value.get("message")?.get("content")?.as_array()?;
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
            return item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string());
        }
    }
    None
}

fn extract_user_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if block_type == "text" {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    let cleaned = strip_openclaw_user_prefix(text);
                    if !cleaned.is_empty() {
                        blocks.push(ContentBlock::Text { text: cleaned });
                    }
                }
            }
        }
    }

    blocks
}

fn extract_assistant_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        // Strip [[reply_to_current]] prefix if present
                        let cleaned = text
                            .strip_prefix("[[reply_to_current]] ")
                            .unwrap_or(text)
                            .to_string();
                        if !cleaned.is_empty() {
                            blocks.push(ContentBlock::Text { text: cleaned });
                        }
                    }
                }
                "thinking" => {
                    if let Some(text) = item.get("thinking").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            blocks.push(ContentBlock::Thinking {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "toolCall" => {
                    let tool_use_id = item
                        .get("id")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                    let tool_name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let input_preview = item.get("arguments").map(|a| {
                        let s = a.to_string();
                        truncate_str(&s, 500)
                    });
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id,
                        tool_name,
                        input_preview,
                    });
                }
                _ => {}
            }
        }
    }

    blocks
}

fn extract_tool_result_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };

    let tool_use_id = message
        .get("toolCallId")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());

    let is_error = message
        .get("isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    let output = message
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            let texts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        });

    blocks.push(ContentBlock::ToolResult {
        tool_use_id,
        output_preview: output,
        is_error,
    });

    blocks
}

fn extract_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    let usage = value.get("message")?.get("usage")?;
    Some(TurnUsage {
        input_tokens: usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_creation_input_tokens: usage
            .get("cacheWrite")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_read_input_tokens: usage
            .get("cacheRead")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

/// Group flat messages into conversation turns.
/// Assistant + Tool messages merge into one Assistant turn.
fn group_into_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    let mut turns = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];

        if matches!(msg.role, MessageRole::User) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::User,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
            });
            i += 1;
        } else if matches!(msg.role, MessageRole::System) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::System,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
            });
            i += 1;
        } else {
            // Assistant or Tool — start a group
            let mut blocks: Vec<ContentBlock> = msg.content.clone();
            let mut usage = msg.usage.clone();
            let duration_ms = msg.duration_ms;
            let turn_model = msg.model.clone();
            let timestamp = msg.timestamp;
            i += 1;

            while i < messages.len()
                && (matches!(messages[i].role, MessageRole::Assistant)
                    || matches!(messages[i].role, MessageRole::Tool))
            {
                blocks.extend(messages[i].content.clone());
                if usage.is_none() {
                    usage = messages[i].usage.clone();
                }
                i += 1;
            }

            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::Assistant,
                blocks,
                timestamp,
                usage,
                duration_ms,
                model: turn_model,
            });
        }
    }

    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn strips_sender_block_and_timestamp() {
        let input = "Sender (untrusted metadata):\n```json\n{\"label\": \"test\"}\n```\n\n[Tue 2026-03-17 12:56 GMT+8] Hello world";
        assert_eq!(strip_openclaw_user_prefix(input), "Hello world");
    }

    #[test]
    fn strips_timestamp_only() {
        let input = "[Tue 2026-03-17 12:56 GMT+8] Hello";
        assert_eq!(strip_openclaw_user_prefix(input), "Hello");
    }

    #[test]
    fn extracts_working_directory() {
        let text = "[Tue 2026-03-17 12:58 GMT+8] [Working directory: ~/forway/agent-workspace]\n\nHello";
        let wd = extract_working_dir(text).unwrap();
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        assert_eq!(wd, format!("{}/forway/agent-workspace", home));
    }

    #[test]
    fn extract_working_dir_returns_none_for_plain_text() {
        assert!(extract_working_dir("Hello world").is_none());
    }

    #[test]
    fn strips_working_dir_prefix() {
        let input = "[Tue 2026-03-17 12:58 GMT+8] [Working directory: ~/projects/test]\n\nHello";
        let result = strip_openclaw_user_prefix(input);
        assert_eq!(result, "Hello");
    }

    #[test]
    fn preserves_plain_text() {
        assert_eq!(strip_openclaw_user_prefix("Hello world"), "Hello world");
    }

    #[test]
    fn extracts_usage_from_openclaw_format() {
        let value = json!({
            "message": {
                "usage": {
                    "input": 6572,
                    "output": 246,
                    "cacheRead": 3584,
                    "cacheWrite": 100,
                    "totalTokens": 10402
                }
            }
        });
        let usage = extract_usage(&value).unwrap();
        assert_eq!(usage.input_tokens, 6572);
        assert_eq!(usage.output_tokens, 246);
        assert_eq!(usage.cache_read_input_tokens, 3584);
        assert_eq!(usage.cache_creation_input_tokens, 100);
    }

    #[test]
    fn extracts_assistant_content_with_thinking_and_tool_call() {
        let value = json!({
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "I should read the file"},
                    {"type": "text", "text": "[[reply_to_current]] Let me check."},
                    {"type": "toolCall", "id": "call_123", "name": "read", "arguments": {"file_path": "/tmp/test"}}
                ]
            }
        });
        let blocks = extract_assistant_content(&value);
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], ContentBlock::Thinking { text } if text == "I should read the file"));
        assert!(matches!(&blocks[1], ContentBlock::Text { text } if text == "Let me check."));
        assert!(matches!(&blocks[2], ContentBlock::ToolUse { tool_name, .. } if tool_name == "read"));
    }

    #[test]
    fn extracts_tool_result_content() {
        let value = json!({
            "message": {
                "role": "toolResult",
                "toolCallId": "call_123",
                "toolName": "read",
                "content": [{"type": "text", "text": "file contents here"}],
                "isError": false
            }
        });
        let blocks = extract_tool_result_content(&value);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(
            &blocks[0],
            ContentBlock::ToolResult { tool_use_id, output_preview, is_error }
            if tool_use_id.as_deref() == Some("call_123")
                && output_preview.as_deref() == Some("file contents here")
                && !is_error
        ));
    }

    #[test]
    fn parses_openclaw_conversation_detail() {
        let path = std::env::temp_dir().join(format!(
            "codeg-openclaw-parser-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::File::create(&path).expect("create temp jsonl");

        writeln!(
            file,
            "{}",
            json!({"type":"session","version":3,"id":"test-session","timestamp":"2026-03-17T04:46:14.113Z","cwd":"/tmp/demo"})
        ).unwrap();

        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-03-17T04:56:22.819Z","message":{"role":"user","content":[{"type":"text","text":"[Tue 2026-03-17 12:56 GMT+8] Hello"}],"timestamp":1773723382812_i64}})
        ).unwrap();

        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-03-17T04:56:30.466Z","message":{"role":"assistant","content":[{"type":"text","text":"[[reply_to_current]] Hi there!"}],"model":"gpt-5.4","usage":{"input":100,"output":50,"cacheRead":200,"cacheWrite":0,"totalTokens":350},"stopReason":"stop","timestamp":1773723390466_i64}})
        ).unwrap();

        let detail = OpenClawParser::parse_conversation_detail(&path, "test/test-session", None)
            .expect("parse detail");
        fs::remove_file(&path).unwrap();

        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert!(matches!(detail.turns[1].role, TurnRole::Assistant));

        // User text should be cleaned
        assert!(matches!(
            &detail.turns[0].blocks[0],
            ContentBlock::Text { text } if text == "Hello"
        ));

        // Assistant text should strip [[reply_to_current]]
        assert!(matches!(
            &detail.turns[1].blocks[0],
            ContentBlock::Text { text } if text == "Hi there!"
        ));

        // Usage should be mapped correctly
        let usage = detail.turns[1].usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_read_input_tokens, 200);

        // Session stats
        let stats = detail.session_stats.unwrap();
        assert!(stats.total_tokens.is_some());
    }
}
