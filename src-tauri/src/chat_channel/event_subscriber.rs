use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::manager::ChatChannelManager;
use super::message_formatter;
use super::types::RichMessage;
use crate::db::service::{app_metadata_service, chat_channel_message_log_service, chat_channel_service};
use crate::web::event_bridge::WebEventBroadcaster;

/// Minimum interval between pushes for the same event type per channel (debounce).
const DEBOUNCE_SECS: u64 = 5;
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";

pub fn spawn_event_subscriber(
    broadcaster: Arc<WebEventBroadcaster>,
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = broadcaster.subscribe();
        let mut last_push: HashMap<(i32, String), Instant> = HashMap::new();

        loop {
            let event = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    eprintln!("[ChatChannel] event subscriber lagged by {n} messages");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    eprintln!("[ChatChannel] event broadcaster closed, stopping subscriber");
                    break;
                }
            };

            let lang = load_lang(&db_conn).await;

            let message = match parse_event(&event.channel, &event.payload, lang) {
                Some((event_type, msg)) => {
                    // Global event filter check
                    let global_filter = app_metadata_service::get_value(&db_conn, "chat_event_filter")
                        .await
                        .ok()
                        .flatten()
                        .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok());

                    if let Some(filter) = &global_filter {
                        if !filter.contains(&event_type) {
                            continue;
                        }
                    }

                    // Check enabled channels and forward
                    let channels = match chat_channel_service::list_enabled(&db_conn).await {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[ChatChannel] failed to list channels: {e}");
                            continue;
                        }
                    };

                    for ch in &channels {
                        // Debounce
                        let key = (ch.id, event_type.clone());
                        let now = Instant::now();
                        if let Some(last) = last_push.get(&key) {
                            if now.duration_since(*last) < Duration::from_secs(DEBOUNCE_SECS) {
                                continue;
                            }
                        }
                        last_push.insert(key, now);

                        // Send
                        let send_result = manager.send_to_channel(ch.id, &msg).await;
                        let (status, error_detail) = match &send_result {
                            Ok(_) => ("sent", None),
                            Err(e) => ("failed", Some(e.to_string())),
                        };

                        let _ = chat_channel_message_log_service::create_log(
                            &db_conn,
                            ch.id,
                            "outbound",
                            "event_push",
                            &msg.to_plain_text(),
                            status,
                            error_detail,
                        )
                        .await;
                    }

                    Some(msg)
                }
                None => None,
            };

            drop(message);
        }
    })
}

async fn load_lang(db: &DatabaseConnection) -> Lang {
    app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

fn parse_event(channel: &str, payload: &serde_json::Value, lang: Lang) -> Option<(String, RichMessage)> {
    match channel {
        "acp://event" => parse_acp_event(payload, lang),
        _ => None,
    }
}

fn parse_acp_event(payload: &serde_json::Value, lang: Lang) -> Option<(String, RichMessage)> {
    let event_type = payload.get("type")?.as_str()?;

    match event_type {
        "turn_complete" => {
            let stop_reason = payload
                .pointer("/data/stop_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            // Only push for end_turn, not for intermediate completions
            if stop_reason != "end_turn" {
                return None;
            }
            let agent_type = payload
                .pointer("/data/agent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Agent");
            Some((
                "turn_complete".to_string(),
                message_formatter::format_turn_complete(agent_type, stop_reason, lang),
            ))
        }
        "error" => {
            let agent_type = payload
                .pointer("/data/agent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Agent");
            let message = payload
                .pointer("/data/message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error");
            Some((
                "error".to_string(),
                message_formatter::format_agent_error(agent_type, message, lang),
            ))
        }
        _ => None,
    }
}
