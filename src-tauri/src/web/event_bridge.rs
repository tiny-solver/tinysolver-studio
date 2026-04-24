use std::sync::Arc;

use serde::{ser::SerializeStruct, Serialize, Serializer};
use tokio::sync::broadcast;

/// Broadcast-delivered event.
///
/// `payload` is wrapped in `Arc` so cloning across broadcast receivers is
/// refcount-only — avoids copying multi-MB JSON trees per subscriber.
#[derive(Clone, Debug)]
pub struct WebEvent {
    pub channel: String,
    pub payload: Arc<serde_json::Value>,
}

impl Serialize for WebEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("WebEvent", 2)?;
        state.serialize_field("channel", &self.channel)?;
        state.serialize_field("payload", self.payload.as_ref())?;
        state.end()
    }
}

pub struct WebEventBroadcaster {
    sender: broadcast::Sender<WebEvent>,
}

impl Default for WebEventBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

impl WebEventBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(4096);
        Self { sender }
    }

    /// Serialize `payload` once and broadcast. Returns the serialized
    /// `Value` so Tauri callers can reuse it without serializing twice.
    pub fn send(&self, channel: &str, payload: &impl Serialize) -> Option<Arc<serde_json::Value>> {
        let value = Arc::new(serde_json::to_value(payload).ok()?);
        if self.sender.receiver_count() > 0 {
            let _ = self.sender.send(WebEvent {
                channel: channel.to_string(),
                payload: value.clone(),
            });
        }
        Some(value)
    }

    /// Broadcast a pre-serialized `Value` without re-serialization.
    pub fn send_value(&self, channel: &str, payload: Arc<serde_json::Value>) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        let _ = self.sender.send(WebEvent {
            channel: channel.to_string(),
            payload,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WebEvent> {
        self.sender.subscribe()
    }
}

/// Abstraction over event emission targets.
/// In Tauri mode, events go to both webview and WebSocket clients.
/// In standalone server mode, events only go to WebSocket clients.
#[derive(Clone)]
pub enum EventEmitter {
    #[cfg(feature = "tauri-runtime")]
    Tauri(tauri::AppHandle),
    WebOnly(Arc<WebEventBroadcaster>),
    /// Silent no-op emitter — drops all events. Used when streaming progress
    /// is not needed (e.g. legacy non-streaming call paths).
    Noop,
}

/// Unified event emission: serializes the payload exactly once and dispatches
/// the shared `Arc<Value>` to both the Tauri webview and the web broadcaster.
pub fn emit_event(emitter: &EventEmitter, event: &str, payload: impl Serialize) {
    match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::{Emitter, Manager};
            let Ok(value) = serde_json::to_value(&payload) else {
                return;
            };
            let shared = Arc::new(value);
            // `&Value` is Copy, so Tauri's `Clone` bound is satisfied without
            // copying the payload — Tauri serializes through the reference.
            let _ = app.emit(event, shared.as_ref());
            if let Some(web) = app.try_state::<Arc<WebEventBroadcaster>>() {
                web.send_value(event, shared);
            }
        }
        EventEmitter::WebOnly(broadcaster) => {
            let _ = broadcaster.send(event, &payload);
        }
        EventEmitter::Noop => {}
    }
}
