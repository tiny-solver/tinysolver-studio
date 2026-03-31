use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{mpsc, Mutex};

use crate::chat_channel::error::ChatChannelError;
use crate::chat_channel::traits::ChatChannelBackend;
use crate::chat_channel::types::*;

pub struct TelegramBackend {
    bot_token: String,
    chat_id: String,
    client: reqwest::Client,
    status: Arc<Mutex<ChannelConnectionStatus>>,
    channel_id: i32,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
}

impl TelegramBackend {
    pub fn new(channel_id: i32, bot_token: String, chat_id: String) -> Self {
        Self {
            bot_token,
            chat_id,
            client: reqwest::Client::new(),
            status: Arc::new(Mutex::new(ChannelConnectionStatus::Disconnected)),
            channel_id,
            shutdown_tx: Arc::new(Mutex::new(None)),
        }
    }

    fn api_url(&self, method: &str) -> String {
        format!(
            "https://api.telegram.org/bot{}/{}",
            self.bot_token, method
        )
    }

    async fn send_text(
        &self,
        text: &str,
        parse_mode: Option<&str>,
    ) -> Result<SentMessageId, ChatChannelError> {
        let mut body = serde_json::json!({
            "chat_id": self.chat_id,
            "text": text,
        });
        if let Some(mode) = parse_mode {
            body["parse_mode"] = serde_json::Value::String(mode.to_string());
        }

        let resp = self
            .client
            .post(self.api_url("sendMessage"))
            .json(&body)
            .send()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        if result.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let desc = result
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(ChatChannelError::SendFailed(desc.to_string()));
        }

        let message_id = result
            .pointer("/result/message_id")
            .and_then(|v| v.as_i64())
            .map(|id| id.to_string())
            .unwrap_or_default();

        Ok(SentMessageId(message_id))
    }
}

#[async_trait]
impl ChatChannelBackend for TelegramBackend {
    fn channel_type(&self) -> ChannelType {
        ChannelType::Telegram
    }

    async fn start(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError> {
        *self.status.lock().await = ChannelConnectionStatus::Connecting;

        // Verify bot token by calling getMe
        let resp = self
            .client
            .get(self.api_url("getMe"))
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        if !resp.status().is_success() {
            *self.status.lock().await = ChannelConnectionStatus::Error;
            return Err(ChatChannelError::AuthenticationFailed(
                "Invalid bot token".to_string(),
            ));
        }

        *self.status.lock().await = ChannelConnectionStatus::Connected;

        // Start long-polling loop
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        let client = self.client.clone();
        let bot_token = self.bot_token.clone();
        let channel_id = self.channel_id;
        let status = self.status.clone();

        tokio::spawn(async move {
            let mut offset: i64 = 0;
            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let url = format!(
                    "https://api.telegram.org/bot{}/getUpdates?timeout=30&offset={}",
                    bot_token, offset
                );

                let result = tokio::select! {
                    r = client.get(&url).send() => r,
                    _ = shutdown_rx.changed() => break,
                };

                match result {
                    Ok(resp) => {
                        if let Ok(body) = resp.json::<serde_json::Value>().await {
                            if let Some(updates) = body.get("result").and_then(|r| r.as_array()) {
                                for update in updates {
                                    if let Some(uid) =
                                        update.get("update_id").and_then(|u| u.as_i64())
                                    {
                                        offset = uid + 1;
                                    }
                                    if let Some(text) = update
                                        .pointer("/message/text")
                                        .and_then(|t| t.as_str())
                                    {
                                        let sender_id = update
                                            .pointer("/message/from/id")
                                            .and_then(|i| i.as_i64())
                                            .map(|i| i.to_string())
                                            .unwrap_or_default();
                                        let _ = command_tx
                                            .send(IncomingCommand {
                                                channel_id,
                                                sender_id,
                                                command_text: text.to_string(),
                                                metadata: update.clone(),
                                            })
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[Telegram] polling error: {e}");
                        *status.lock().await = ChannelConnectionStatus::Error;
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                        *status.lock().await = ChannelConnectionStatus::Connected;
                    }
                }
            }
            *status.lock().await = ChannelConnectionStatus::Disconnected;
        });

        Ok(())
    }

    async fn stop(&self) -> Result<(), ChatChannelError> {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(true);
        }
        *self.status.lock().await = ChannelConnectionStatus::Disconnected;
        Ok(())
    }

    async fn status(&self) -> ChannelConnectionStatus {
        *self.status.lock().await
    }

    async fn send_message(&self, text: &str) -> Result<SentMessageId, ChatChannelError> {
        self.send_text(text, None).await
    }

    async fn send_rich_message(
        &self,
        message: &RichMessage,
    ) -> Result<SentMessageId, ChatChannelError> {
        let markdown_text = format_telegram_markdown(message);
        let result = self.send_text(&markdown_text, Some("MarkdownV2")).await;

        match result {
            Ok(id) => Ok(id),
            Err(e) => {
                // MarkdownV2 failed — fall back to plain text
                eprintln!("[Telegram] MarkdownV2 send failed: {e}, retrying as plain text");
                let plain_text = message.to_plain_text();
                self.send_text(&plain_text, None).await
            }
        }
    }

    async fn test_connection(&self) -> Result<(), ChatChannelError> {
        let resp = self
            .client
            .get(self.api_url("getMe"))
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        if resp.status().is_success() {
            Ok(())
        } else {
            Err(ChatChannelError::AuthenticationFailed(
                "Invalid bot token".to_string(),
            ))
        }
    }
}

fn format_telegram_markdown(msg: &RichMessage) -> String {
    let mut text = String::new();

    let level_emoji = match msg.level {
        MessageLevel::Info => "ℹ️",
        MessageLevel::Warning => "⚠️",
        MessageLevel::Error => "❌",
    };

    if let Some(title) = &msg.title {
        text.push_str(&format!("{} *{}*\n", level_emoji, escape_markdown(title)));
    }

    text.push_str(&escape_markdown(&msg.body));

    if !msg.fields.is_empty() {
        text.push('\n');
        for (key, value) in &msg.fields {
            text.push_str(&format!(
                "\n*{}*: {}",
                escape_markdown(key),
                escape_markdown(value)
            ));
        }
    }

    text
}

fn escape_markdown(text: &str) -> String {
    // Backslash must be escaped first to avoid double-escaping
    text.replace('\\', "\\\\")
        .replace('_', "\\_")
        .replace('*', "\\*")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('(', "\\(")
        .replace(')', "\\)")
        .replace('~', "\\~")
        .replace('`', "\\`")
        .replace('>', "\\>")
        .replace('#', "\\#")
        .replace('+', "\\+")
        .replace('-', "\\-")
        .replace('=', "\\=")
        .replace('|', "\\|")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('.', "\\.")
        .replace('!', "\\!")
}
