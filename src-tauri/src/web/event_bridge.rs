use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Clone, Debug, Serialize)]
pub struct WebEvent {
    pub channel: String,
    pub payload: serde_json::Value,
}

pub struct WebEventBroadcaster {
    sender: broadcast::Sender<WebEvent>,
}

impl WebEventBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(4096);
        Self { sender }
    }

    pub fn send(&self, channel: &str, payload: &impl Serialize) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        if let Ok(value) = serde_json::to_value(payload) {
            let _ = self.sender.send(WebEvent {
                channel: channel.to_string(),
                payload: value,
            });
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WebEvent> {
        self.sender.subscribe()
    }
}

/// Unified event emission: sends to both Tauri webview and Web clients.
pub fn emit_event(
    app: &tauri::AppHandle,
    event: &str,
    payload: impl Serialize + Clone,
) {
    use tauri::{Emitter, Manager};
    let _ = app.emit(event, payload.clone());
    if let Some(web) = app.try_state::<WebEventBroadcaster>() {
        web.send(event, &payload);
    }
}
