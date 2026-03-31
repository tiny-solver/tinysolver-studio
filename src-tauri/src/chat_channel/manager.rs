use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::{mpsc, Mutex};

use super::error::ChatChannelError;
use super::traits::ChatChannelBackend;
use super::types::*;
use crate::web::event_bridge::WebEventBroadcaster;

struct ActiveChannel {
    id: i32,
    name: String,
    channel_type: ChannelType,
    backend: Box<dyn ChatChannelBackend>,
}

/// Inner state shared across clones.
struct Inner {
    channels: Mutex<HashMap<i32, ActiveChannel>>,
    command_tx: mpsc::Sender<IncomingCommand>,
    command_rx: Mutex<Option<mpsc::Receiver<IncomingCommand>>>,
}

pub struct ChatChannelManager {
    inner: Arc<Inner>,
}

impl Default for ChatChannelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ChatChannelManager {
    pub fn new() -> Self {
        let (command_tx, command_rx) = mpsc::channel(256);
        Self {
            inner: Arc::new(Inner {
                channels: Mutex::new(HashMap::new()),
                command_tx,
                command_rx: Mutex::new(Some(command_rx)),
            }),
        }
    }

    /// Shallow clone sharing the same state (like ConnectionManager::clone_ref).
    pub fn clone_ref(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }

    pub fn command_sender(&self) -> mpsc::Sender<IncomingCommand> {
        self.inner.command_tx.clone()
    }

    /// Take the command receiver (can only be called once, at startup).
    pub async fn take_command_receiver(&self) -> Option<mpsc::Receiver<IncomingCommand>> {
        self.inner.command_rx.lock().await.take()
    }

    pub async fn add_channel(
        &self,
        id: i32,
        name: String,
        channel_type: ChannelType,
        backend: Box<dyn ChatChannelBackend>,
    ) -> Result<(), ChatChannelError> {
        let command_tx = self.inner.command_tx.clone();
        backend.start(command_tx).await?;

        let channel = ActiveChannel {
            id,
            name,
            channel_type,
            backend,
        };

        self.inner.channels.lock().await.insert(id, channel);
        Ok(())
    }

    pub async fn remove_channel(&self, id: i32) -> Result<(), ChatChannelError> {
        let mut channels = self.inner.channels.lock().await;
        if let Some(channel) = channels.remove(&id) {
            channel.backend.stop().await?;
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let mut channels = self.inner.channels.lock().await;
        for (_, channel) in channels.drain() {
            let _ = channel.backend.stop().await;
        }
    }

    pub async fn send_to_channel(
        &self,
        channel_id: i32,
        message: &RichMessage,
    ) -> Result<SentMessageId, ChatChannelError> {
        let channels = self.inner.channels.lock().await;
        let channel = channels
            .get(&channel_id)
            .ok_or(ChatChannelError::NotFound(channel_id))?;
        channel.backend.send_rich_message(message).await
    }

    pub async fn send_to_all(&self, message: &RichMessage) {
        let channels = self.inner.channels.lock().await;
        for (_, channel) in channels.iter() {
            let _ = channel.backend.send_rich_message(message).await;
        }
    }

    pub async fn get_status(&self) -> Vec<crate::models::ChannelStatusInfo> {
        let channels = self.inner.channels.lock().await;
        let mut result = Vec::new();
        for (_, ch) in channels.iter() {
            let status = ch.backend.status().await;
            result.push(crate::models::ChannelStatusInfo {
                channel_id: ch.id,
                name: ch.name.clone(),
                channel_type: ch.channel_type.to_string(),
                status: serde_json::to_value(status)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "unknown".to_string()),
            });
        }
        result
    }

    pub async fn test_channel(&self, id: i32) -> Result<(), ChatChannelError> {
        let channels = self.inner.channels.lock().await;
        let channel = channels
            .get(&id)
            .ok_or(ChatChannelError::NotFound(id))?;
        channel.backend.test_connection().await
    }

    pub async fn is_connected(&self, id: i32) -> bool {
        let channels = self.inner.channels.lock().await;
        if let Some(ch) = channels.get(&id) {
            ch.backend.status().await == ChannelConnectionStatus::Connected
        } else {
            false
        }
    }

    /// Start background tasks (event subscriber + command dispatcher) and
    /// auto-connect all enabled channels from DB.
    pub async fn start_background(
        &self,
        broadcaster: Arc<WebEventBroadcaster>,
        db_conn: DatabaseConnection,
    ) {
        let db_conn2 = db_conn.clone();

        // Spawn event subscriber
        let manager_for_events = self.clone_ref();
        super::event_subscriber::spawn_event_subscriber(
            broadcaster,
            manager_for_events,
            db_conn.clone(),
        );

        // Spawn command dispatcher
        if let Some(command_rx) = self.take_command_receiver().await {
            let manager_for_cmds = self.clone_ref();
            super::command_dispatcher::spawn_command_dispatcher(
                command_rx,
                manager_for_cmds,
                db_conn.clone(),
            );
        }

        // Spawn daily report scheduler
        let manager_for_scheduler = self.clone_ref();
        super::scheduler::spawn_daily_report_scheduler(manager_for_scheduler, db_conn.clone());

        // Auto-connect enabled channels
        self.auto_connect_channels(&db_conn2).await;
    }

    async fn auto_connect_channels(&self, db_conn: &DatabaseConnection) {
        let channels =
            match crate::db::service::chat_channel_service::list_enabled(db_conn).await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[ChatChannel] failed to load enabled channels: {e}");
                    return;
                }
            };

        for ch in channels {
            let channel_type: ChannelType = match serde_json::from_value(
                serde_json::Value::String(ch.channel_type.clone()),
            ) {
                Ok(t) => t,
                Err(_) => continue,
            };

            let config: serde_json::Value = match serde_json::from_str(&ch.config_json) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let token = match crate::keyring_store::get_channel_token(ch.id) {
                Some(t) => t,
                None => continue,
            };

            let backend: Box<dyn ChatChannelBackend> = match channel_type {
                ChannelType::Telegram => {
                    let chat_id = config
                        .get("chat_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if chat_id.is_empty() {
                        continue;
                    }
                    Box::new(super::backends::telegram::TelegramBackend::new(
                        ch.id, token, chat_id,
                    ))
                }
                ChannelType::Lark => {
                    let app_id = config
                        .get("app_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let chat_id = config
                        .get("chat_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if app_id.is_empty() || chat_id.is_empty() {
                        continue;
                    }
                    Box::new(super::backends::lark::LarkBackend::new(
                        ch.id, app_id, token, chat_id,
                    ))
                }
            };

            if let Err(e) = self.add_channel(ch.id, ch.name.clone(), channel_type, backend).await {
                eprintln!(
                    "[ChatChannel] failed to auto-connect '{}' (id={}): {e}",
                    ch.name, ch.id
                );
            } else {
                eprintln!("[ChatChannel] auto-connected '{}' (id={})", ch.name, ch.id);
            }
        }
    }
}
