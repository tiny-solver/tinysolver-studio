use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::session_bridge::{PendingPermission, SessionBridge};
use super::types::{MessageLevel, RichMessage};
use crate::acp::manager::ConnectionManager;
use crate::acp::types::PromptInputBlock;
use crate::db::service::{
    app_metadata_service, conversation_service, sender_context_service,
};
use crate::web::event_bridge::WebEventBroadcaster;

use super::manager::ChatChannelManager;

const FLUSH_INTERVAL_SECS: u64 = 5;
const BUFFER_FLUSH_THRESHOLD: usize = 500;
const MAX_MESSAGE_LEN: usize = 2000;
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";

pub fn spawn_session_event_subscriber(
    broadcaster: Arc<WebEventBroadcaster>,
    bridge: Arc<Mutex<SessionBridge>>,
    manager: ChatChannelManager,
    conn_mgr: ConnectionManager,
    db_conn: DatabaseConnection,
) -> JoinHandle<()> {
    let mut rx = broadcaster.subscribe();

    tokio::spawn(async move {
        let mut last_heartbeat = Instant::now();

        loop {
            tokio::select! {
                result = rx.recv() => {
                    let event = match result {
                        Ok(e) => e,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("[SessionEventSub] lagged {n} events");
                            continue;
                        }
                        Err(_) => break,
                    };

                    if event.channel == "acp://event" {
                        handle_acp_event_payload(
                            &event.payload,
                            &bridge,
                            &manager,
                            &conn_mgr,
                            &db_conn,
                        )
                        .await;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(FLUSH_INTERVAL_SECS)) => {
                    if last_heartbeat.elapsed() >= Duration::from_secs(FLUSH_INTERVAL_SECS) {
                        flush_progress(&bridge, &manager).await;
                        last_heartbeat = Instant::now();
                    }
                }
            }
        }
    })
}

async fn get_lang(db: &DatabaseConnection) -> Lang {
    app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

async fn handle_acp_event_payload(
    payload: &serde_json::Value,
    bridge: &Arc<Mutex<SessionBridge>>,
    manager: &ChatChannelManager,
    conn_mgr: &ConnectionManager,
    db: &DatabaseConnection,
) {
    let event_type = match payload.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };
    let connection_id = match payload.get("connection_id").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return,
    };

    match event_type {
        "session_started" => {
            let session_id = payload
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                let _ = conversation_service::update_external_id(
                    db,
                    session.conversation_id,
                    session_id.to_string(),
                )
                .await;

                if let Some(prompt_text) = session.pending_prompt.take() {
                    let blocks = vec![PromptInputBlock::Text { text: prompt_text }];
                    if let Err(e) = conn_mgr.send_prompt(connection_id, blocks).await {
                        eprintln!("[SessionEventSub] failed to send pending prompt: {e}");
                        let channel_id = session.channel_id;
                        let msg = RichMessage::error(format!("Failed to send task: {e}"));
                        let _ = manager.send_to_channel(channel_id, &msg).await;
                    }
                }
            }
        }

        "content_delta" => {
            let text = payload
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                session.content_buffer.push_str(text);

                if session.content_buffer.len() >= BUFFER_FLUSH_THRESHOLD
                    && session.last_flushed.elapsed() >= Duration::from_secs(2)
                {
                    let channel_id = session.channel_id;
                    let buf_len = session.content_buffer.len();
                    let last_tool = session.tool_calls.last().cloned();
                    session.last_flushed = Instant::now();

                    let mut status = format!("... ({buf_len} chars)");
                    if let Some(tool) = last_tool {
                        status.push_str(&format!(" | {tool}"));
                    }
                    drop(guard);

                    let msg = RichMessage::info(status);
                    let _ = manager.send_to_channel(channel_id, &msg).await;
                }
            }
        }

        "tool_call" => {
            let title = payload
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("tool");
            let status = payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                session.tool_calls.push(title.to_string());
                let channel_id = session.channel_id;
                drop(guard);

                if status != "completed" {
                    let msg = RichMessage::info(format!(">> {title}"));
                    let _ = manager.send_to_channel(channel_id, &msg).await;
                }
            }
        }

        "tool_call_update" => {
            let title = payload.get("title").and_then(|v| v.as_str());
            let status = payload.get("status").and_then(|v| v.as_str());

            if let (Some(title), Some("completed")) = (title, status) {
                let guard = bridge.lock().await;
                if let Some(session) = guard.get(connection_id) {
                    let channel_id = session.channel_id;
                    drop(guard);

                    let msg = RichMessage::info(format!(">> {title} [done]"));
                    let _ = manager.send_to_channel(channel_id, &msg).await;
                }
            }
        }

        "permission_request" => {
            let request_id = payload
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tool_call = payload
                .get("tool_call")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let options: Vec<crate::acp::types::PermissionOptionInfo> = payload
                .get("options")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                let channel_id = session.channel_id;
                let sender_id = session.sender_id.clone();

                let auto_approve = sender_context_service::get_or_create(
                    db,
                    channel_id,
                    &sender_id,
                )
                .await
                .map(|ctx| ctx.auto_approve)
                .unwrap_or(false);

                if auto_approve {
                    let option_id = options
                        .iter()
                        .find(|o| o.kind == "allow" || o.kind == "allowForSession")
                        .or_else(|| options.first())
                        .map(|o| o.option_id.clone());

                    drop(guard);

                    if let Some(oid) = option_id {
                        let _ = conn_mgr
                            .respond_permission(connection_id, request_id, &oid)
                            .await;
                    }
                    return;
                }

                let tool_desc = tool_call
                    .get("title")
                    .and_then(|v| v.as_str())
                    .or_else(|| tool_call.get("tool_name").and_then(|v| v.as_str()))
                    .unwrap_or("Unknown tool")
                    .to_string();

                session.permission_pending = Some(PendingPermission {
                    request_id: request_id.to_string(),
                    tool_description: tool_desc.clone(),
                    options,
                    sent_message_id: None,
                });

                drop(guard);

                let lang = get_lang(db).await;
                let body = match lang {
                    Lang::ZhCn | Lang::ZhTw => {
                        format!("Agent 请求权限: {tool_desc}\n\n/approve 批准 | /deny 拒绝 | /approve always 自动批准")
                    }
                    _ => {
                        format!("Agent requests permission: {tool_desc}\n\n/approve | /deny | /approve always")
                    }
                };

                let msg = RichMessage {
                    title: Some(match lang {
                        Lang::ZhCn | Lang::ZhTw => "权限请求".to_string(),
                        _ => "Permission Request".to_string(),
                    }),
                    body,
                    fields: Vec::new(),
                    level: MessageLevel::Warning,
                };
                let _ = manager.send_to_channel(channel_id, &msg).await;
            }
        }

        "turn_complete" => {
            let stop_reason = payload
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let agent_type = payload
                .get("agent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                let channel_id = session.channel_id;
                let conv_id = session.conversation_id;
                let content = std::mem::take(&mut session.content_buffer);
                let tool_count = session.tool_calls.len();
                session.tool_calls.clear();
                session.last_flushed = Instant::now();
                drop(guard);

                let lang = get_lang(db).await;
                let body = format_completion(&content, tool_count, lang);

                let msg = RichMessage::info(body)
                    .with_title(match lang {
                        Lang::ZhCn | Lang::ZhTw => "任务完成",
                        _ => "Turn Complete",
                    })
                    .with_field("Agent", agent_type)
                    .with_field(
                        match lang {
                            Lang::ZhCn | Lang::ZhTw => "结束原因",
                            _ => "Stop Reason",
                        },
                        stop_reason,
                    );

                let _ = manager.send_to_channel(channel_id, &msg).await;

                if stop_reason == "end_turn" {
                    let _ = conversation_service::update_status(
                        db,
                        conv_id,
                        crate::db::entities::conversation::ConversationStatus::Completed,
                    )
                    .await;
                }
            }
        }

        "error" => {
            let message = payload
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            let agent_type = payload
                .get("agent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.remove(connection_id) {
                let channel_id = session.channel_id;
                let sender_id = session.sender_id.clone();
                let conv_id = session.conversation_id;
                drop(guard);

                let lang = get_lang(db).await;
                let msg = RichMessage {
                    title: Some(match lang {
                        Lang::ZhCn | Lang::ZhTw => "Agent 错误".to_string(),
                        _ => "Agent Error".to_string(),
                    }),
                    body: format!("[{agent_type}] {message}"),
                    fields: Vec::new(),
                    level: MessageLevel::Error,
                };
                let _ = manager.send_to_channel(channel_id, &msg).await;

                let _ = conversation_service::update_status(
                    db,
                    conv_id,
                    crate::db::entities::conversation::ConversationStatus::Cancelled,
                )
                .await;
                let _ =
                    sender_context_service::clear_session(db, channel_id, &sender_id).await;
            }
        }

        "status_changed" => {
            let status = payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if status == "disconnected" || status == "error" {
                let mut guard = bridge.lock().await;
                if let Some(session) = guard.remove(connection_id) {
                    let channel_id = session.channel_id;
                    let sender_id = session.sender_id.clone();
                    drop(guard);

                    let _ =
                        sender_context_service::clear_session(db, channel_id, &sender_id).await;
                }
            }
        }

        _ => {}
    }
}

async fn flush_progress(bridge: &Arc<Mutex<SessionBridge>>, manager: &ChatChannelManager) {
    let updates: Vec<(i32, String)> = {
        let mut guard = bridge.lock().await;
        let mut out = Vec::new();
        for session in guard.all_sessions_mut() {
            if !session.content_buffer.is_empty()
                && session.last_flushed.elapsed() >= Duration::from_secs(FLUSH_INTERVAL_SECS)
            {
                let buf_len = session.content_buffer.len();
                let tool_count = session.tool_calls.len();
                session.last_flushed = Instant::now();
                out.push((
                    session.channel_id,
                    format!("... ({buf_len} chars, {tool_count} tools)"),
                ));
            }
        }
        out
    };

    for (channel_id, text) in updates {
        let msg = RichMessage::info(text);
        let _ = manager.send_to_channel(channel_id, &msg).await;
    }
}

fn format_completion(content: &str, tool_count: usize, lang: Lang) -> String {
    if content.is_empty() {
        return match lang {
            Lang::ZhCn | Lang::ZhTw => format!("(无文本输出, {tool_count} 次工具调用)"),
            _ => format!("(No text output, {tool_count} tool calls)"),
        };
    }

    if content.len() <= MAX_MESSAGE_LEN {
        let mut body = content.to_string();
        if tool_count > 0 {
            body.push_str(&format!(
                "\n\n[{} {}]",
                tool_count,
                match lang {
                    Lang::ZhCn | Lang::ZhTw => "次工具调用",
                    _ => "tool calls",
                }
            ));
        }
        return body;
    }

    // Truncate long content
    let head = &content[..500.min(content.len())];
    let tail_start = content.len().saturating_sub(500);
    let tail = &content[tail_start..];

    match lang {
        Lang::ZhCn | Lang::ZhTw => {
            format!(
                "{head}\n\n...\n\n{tail}\n\n[完整回复: {} 字符, {tool_count} 次工具调用]",
                content.len()
            )
        }
        _ => {
            format!(
                "{head}\n\n...\n\n{tail}\n\n[Full response: {} chars, {tool_count} tool calls]",
                content.len()
            )
        }
    }
}
