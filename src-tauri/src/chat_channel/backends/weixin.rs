use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::Rng;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};

use crate::chat_channel::error::ChatChannelError;
use crate::chat_channel::traits::ChatChannelBackend;
use crate::chat_channel::types::*;

const ILINK_BASE_URL: &str = "https://ilinkai.weixin.qq.com";

// ── QR code auth types (public, used by commands) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeInfo {
    pub qrcode_id: String,
    pub qrcode_img_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

// ── QR code auth functions (called before backend exists) ──

pub async fn weixin_get_qrcode() -> Result<WeixinQrcodeInfo, ChatChannelError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_bot_qrcode"))
        .query(&[("bot_type", "3")])
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR code request failed: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR code parse failed: {e}")))?;

    let qrcode_id = body
        .get("qrcode")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let raw_img = body
        .get("qrcode_img_content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if qrcode_id.is_empty() {
        return Err(ChatChannelError::ConnectionFailed(
            "Empty qrcode in response".into(),
        ));
    }

    // If the image content is a URL, fetch the actual image bytes and
    // convert to a data-URI so the frontend can display it without CORS issues.
    let qrcode_img_content = if raw_img.starts_with("http://") || raw_img.starts_with("https://") {
        match fetch_image_as_data_uri(&client, &raw_img).await {
            Ok(data_uri) => data_uri,
            Err(e) => {
                eprintln!("[Weixin] failed to proxy QR image: {e}, falling back to URL");
                raw_img
            }
        }
    } else {
        raw_img
    };

    Ok(WeixinQrcodeInfo {
        qrcode_id,
        qrcode_img_content,
    })
}

/// Fetch an image from a URL and return it as a `data:<mime>;base64,...` string.
async fn fetch_image_as_data_uri(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, ChatChannelError> {
    let resp = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .header(reqwest::header::REFERER, ILINK_BASE_URL)
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("Image fetch failed: {e}")))?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();

    // If the server returned HTML instead of an image, bail out
    if content_type.contains("text/html") || content_type.contains("text/plain") {
        return Err(ChatChannelError::ConnectionFailed(format!(
            "Expected image but got {content_type}"
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("Image read failed: {e}")))?;

    let b64 = B64.encode(&bytes);
    // Normalize content-type: strip parameters like charset
    let mime = content_type.split(';').next().unwrap_or("image/png").trim();
    Ok(format!("data:{mime};base64,{b64}"))
}

pub async fn weixin_check_qrcode(
    qrcode: &str,
) -> Result<WeixinQrcodeStatus, ChatChannelError> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_qrcode_status"))
        .query(&[("qrcode", qrcode)])
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR status request failed: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR status parse failed: {e}")))?;

    let status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("waiting")
        .to_string();

    let bot_token = body
        .get("bot_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let base_url = body
        .get("baseurl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(WeixinQrcodeStatus {
        status,
        bot_token,
        base_url,
    })
}

// ── Backend implementation ──

struct WeixinReplyContext {
    to_user_id: String,
    context_token: String,
    expired: bool,
}

pub struct WeixinBackend {
    bot_token: String,
    base_url: String,
    client: reqwest::Client,
    status: Arc<Mutex<ChannelConnectionStatus>>,
    channel_id: i32,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
    reply_context: Arc<Mutex<Option<WeixinReplyContext>>>,
    /// Messages that failed due to expired context_token, resend on next refresh.
    pending_messages: Arc<Mutex<Vec<String>>>,
}

impl WeixinBackend {
    pub fn new(channel_id: i32, bot_token: String, base_url: String) -> Self {
        Self {
            bot_token,
            base_url,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_default(),
            status: Arc::new(Mutex::new(ChannelConnectionStatus::Disconnected)),
            channel_id,
            shutdown_tx: Arc::new(Mutex::new(None)),
            reply_context: Arc::new(Mutex::new(None)),
            pending_messages: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn build_headers(bot_token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("Content-Type", HeaderValue::from_static("application/json"));
        headers.insert(
            "AuthorizationType",
            HeaderValue::from_static("ilink_bot_token"),
        );

        let uin_raw = rand::thread_rng().gen::<u32>().to_string();
        let uin_b64 = B64.encode(uin_raw.as_bytes());
        if let Ok(val) = HeaderValue::from_str(&uin_b64) {
            headers.insert("X-WECHAT-UIN", val);
        }

        let bearer = format!("Bearer {bot_token}");
        if let Ok(val) = HeaderValue::from_str(&bearer) {
            headers.insert("Authorization", val);
        }

        headers
    }

    async fn send_text(
        &self,
        text: &str,
    ) -> Result<SentMessageId, ChatChannelError> {
        // Extract context data under lock, then release
        let (to_user_id, context_token, expired) = {
            let guard = self.reply_context.lock().await;
            let ctx = guard.as_ref().ok_or_else(|| {
                ChatChannelError::SendFailed(
                    "No active WeChat conversation context. A user must message the bot first."
                        .into(),
                )
            })?;
            (
                ctx.to_user_id.clone(),
                ctx.context_token.clone(),
                ctx.expired,
            )
        };

        // If context is expired, buffer the message for resend on next refresh
        if expired {
            eprintln!(
                "[Weixin] context expired, buffering message (len={})",
                text.len()
            );
            self.pending_messages.lock().await.push(text.to_string());
            return Ok(SentMessageId(String::new()));
        }

        let client_id = format!("codeg-{}", uuid::Uuid::new_v4());
        let body = serde_json::json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": client_id,
                "message_type": 2,
                "message_state": 2,
                "context_token": context_token,
                "item_list": [{
                    "type": 1,
                    "text_item": { "text": text }
                }]
            },
            "base_info": { "channel_version": "1.0.2" }
        });

        let url = format!("{}/ilink/bot/sendmessage", self.base_url);
        eprintln!(
            "[Weixin] sendmessage to={to_user_id}, context_token_len={}, text_len={}",
            context_token.len(),
            text.len()
        );

        let resp = self
            .client
            .post(&url)
            .headers(Self::build_headers(&self.bot_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp.text().await.unwrap_or_default();
        eprintln!("[Weixin] sendmessage response: status={status_code}, body={resp_text}");

        if !status_code.is_success() {
            return Err(ChatChannelError::SendFailed(format!(
                "HTTP {status_code}: {resp_text}"
            )));
        }

        // Check for ret errors in response (e.g. -2 = context expired)
        if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(ret) = resp_json.get("ret").and_then(|v| v.as_i64()) {
                if ret != 0 {
                    let errmsg = resp_json
                        .get("errmsg")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    eprintln!("[Weixin] sendmessage ret={ret}, errmsg={errmsg}");

                    if ret == -2 {
                        // Context token expired — mark stale and buffer
                        if let Some(ref mut c) = *self.reply_context.lock().await {
                            c.expired = true;
                        }
                        self.pending_messages.lock().await.push(text.to_string());
                        eprintln!("[Weixin] context_token expired (ret=-2), buffered message");
                        return Ok(SentMessageId(String::new()));
                    }

                    return Err(ChatChannelError::SendFailed(format!(
                        "ret={ret}: {errmsg}"
                    )));
                }
            }
        }

        Ok(SentMessageId(String::new()))
    }
}

#[async_trait]
impl ChatChannelBackend for WeixinBackend {
    fn channel_type(&self) -> ChannelType {
        ChannelType::Weixin
    }

    async fn start(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError> {
        *self.status.lock().await = ChannelConnectionStatus::Connecting;

        eprintln!(
            "[Weixin] start: base_url={}, token_len={}",
            self.base_url,
            self.bot_token.len()
        );

        // Verify auth by doing a quick getupdates with empty cursor
        let verify_body = serde_json::json!({
            "get_updates_buf": "",
            "base_info": { "channel_version": "1.0.2" }
        });
        let url = format!("{}/ilink/bot/getupdates", self.base_url);
        eprintln!("[Weixin] verify POST {url}");

        let resp = self
            .client
            .post(&url)
            .headers(Self::build_headers(&self.bot_token))
            .json(&verify_body)
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        eprintln!("[Weixin] verify response status={status_code}, body={resp_text}");

        let verify_result: serde_json::Value =
            serde_json::from_str(&resp_text).map_err(|e| {
                ChatChannelError::ConnectionFailed(format!("JSON parse failed: {e}"))
            })?;

        let ret = verify_result
            .get("ret")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);

        // The iLink API may omit the `ret` field or return non-zero on the first
        // call. Always extract the cursor if present — it's needed for polling.
        let initial_cursor = verify_result
            .get("get_updates_buf")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if ret != 0 {
            eprintln!(
                "[Weixin] verify returned ret={ret}, but got cursor len={}",
                initial_cursor.len()
            );
        }

        *self.status.lock().await = ChannelConnectionStatus::Connected;

        // Start long-polling loop
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        let client = self.client.clone();
        let bot_token = self.bot_token.clone();
        let base_url = self.base_url.clone();
        let channel_id = self.channel_id;
        let status = self.status.clone();
        let reply_context = self.reply_context.clone();
        let pending_messages = self.pending_messages.clone();

        tokio::spawn(async move {
            let mut cursor = initial_cursor;

            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let body = serde_json::json!({
                    "get_updates_buf": cursor,
                    "base_info": { "channel_version": "1.0.2" }
                });

                let result = tokio::select! {
                    r = client
                        .post(format!("{base_url}/ilink/bot/getupdates"))
                        .headers(WeixinBackend::build_headers(&bot_token))
                        .json(&body)
                        .send() => r,
                    _ = shutdown_rx.changed() => break,
                };

                match result {
                    Ok(resp) => {
                        // Recover from error state after successful poll
                        {
                            let mut s = status.lock().await;
                            if *s == ChannelConnectionStatus::Error {
                                *s = ChannelConnectionStatus::Connected;
                            }
                        }

                        if let Ok(body) = resp.json::<serde_json::Value>().await {
                            let ret = body.get("ret").and_then(|v| v.as_i64());

                            // Always update cursor if present
                            if let Some(new_cursor) =
                                body.get("get_updates_buf").and_then(|v| v.as_str())
                            {
                                if !new_cursor.is_empty() {
                                    cursor = new_cursor.to_string();
                                }
                            }

                            // If ret is explicitly non-zero (not just missing), log it
                            if let Some(r) = ret {
                                if r != 0 {
                                    eprintln!("[Weixin] getupdates ret={r}");
                                }
                            }

                            // Process messages
                            if let Some(msgs) = body.get("msgs").and_then(|v| v.as_array()) {
                                if !msgs.is_empty() {
                                    eprintln!("[Weixin] got {} message(s)", msgs.len());
                                }
                                for msg in msgs {
                                    // Only handle text messages (type 1 in item_list)
                                    let text = msg
                                        .get("item_list")
                                        .and_then(|v| v.as_array())
                                        .and_then(|items| {
                                            items.iter().find_map(|item| {
                                                let t =
                                                    item.get("type").and_then(|v| v.as_i64())?;
                                                if t == 1 {
                                                    item.pointer("/text_item/text")
                                                        .and_then(|v| v.as_str())
                                                } else {
                                                    None
                                                }
                                            })
                                        });

                                    let text = match text {
                                        Some(t) if !t.is_empty() => t,
                                        _ => {
                                            eprintln!("[Weixin] skipped non-text message");
                                            continue;
                                        }
                                    };

                                    let from_user_id = msg
                                        .get("from_user_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default();
                                    let context_token = msg
                                        .get("context_token")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default();

                                    // Store reply context for outbound messages
                                    if !from_user_id.is_empty() && !context_token.is_empty() {
                                        let was_expired = reply_context
                                            .lock()
                                            .await
                                            .as_ref()
                                            .map(|c| c.expired)
                                            .unwrap_or(false);

                                        *reply_context.lock().await = Some(WeixinReplyContext {
                                            to_user_id: from_user_id.to_string(),
                                            context_token: context_token.to_string(),
                                            expired: false,
                                        });

                                        // Resend buffered messages with fresh context
                                        if was_expired {
                                            let buffered: Vec<String> =
                                                pending_messages.lock().await.drain(..).collect();
                                            if !buffered.is_empty() {
                                                eprintln!(
                                                    "[Weixin] context refreshed, resending {} buffered message(s)",
                                                    buffered.len()
                                                );
                                                for pending_text in &buffered {
                                                    let cid =
                                                        format!("codeg-{}", uuid::Uuid::new_v4());
                                                    let send_body = serde_json::json!({
                                                        "msg": {
                                                            "from_user_id": "",
                                                            "to_user_id": from_user_id,
                                                            "client_id": cid,
                                                            "message_type": 2,
                                                            "message_state": 2,
                                                            "context_token": context_token,
                                                            "item_list": [{
                                                                "type": 1,
                                                                "text_item": { "text": pending_text }
                                                            }]
                                                        },
                                                        "base_info": { "channel_version": "1.0.2" }
                                                    });
                                                    let _ = client
                                                        .post(format!(
                                                            "{base_url}/ilink/bot/sendmessage"
                                                        ))
                                                        .headers(WeixinBackend::build_headers(
                                                            &bot_token,
                                                        ))
                                                        .json(&send_body)
                                                        .send()
                                                        .await;
                                                }
                                            }
                                        }
                                    }

                                    eprintln!("[Weixin] dispatching: {text}");
                                    let send_result = command_tx
                                        .send(IncomingCommand {
                                            channel_id,
                                            sender_id: from_user_id.to_string(),
                                            command_text: text.to_string(),
                                            metadata: msg.clone(),
                                        })
                                        .await;
                                    if let Err(e) = send_result {
                                        eprintln!("[Weixin] command_tx.send failed: {e}");
                                    }
                                }
                            }
                        } else {
                            eprintln!("[Weixin] failed to parse response body");
                        }
                    }
                    Err(e) => {
                        eprintln!("[Weixin] polling error: {e}");
                        *status.lock().await = ChannelConnectionStatus::Error;
                        tokio::time::sleep(Duration::from_secs(5)).await;
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
        self.send_text(text).await
    }

    async fn send_rich_message(
        &self,
        message: &RichMessage,
    ) -> Result<SentMessageId, ChatChannelError> {
        let plain_text = message.to_plain_text();
        self.send_text(&plain_text).await
    }

    async fn test_connection(&self) -> Result<(), ChatChannelError> {
        let body = serde_json::json!({
            "get_updates_buf": "",
            "base_info": { "channel_version": "1.0.2" }
        });

        let url = format!("{}/ilink/bot/getupdates", self.base_url);
        let resp = self
            .client
            .post(&url)
            .headers(Self::build_headers(&self.bot_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        eprintln!("[Weixin] test_connection: status={status_code}, body={resp_text}");

        // As long as we got a valid JSON response from the server, treat it as reachable.
        // The iLink API may return ret != 0 on first empty-cursor call.
        let _: serde_json::Value = serde_json::from_str(&resp_text).map_err(|e| {
            ChatChannelError::ConnectionFailed(format!("Not valid JSON: {e}"))
        })?;

        if !status_code.is_success() {
            return Err(ChatChannelError::AuthenticationFailed(format!(
                "HTTP {status_code}"
            )));
        }

        Ok(())
    }
}
