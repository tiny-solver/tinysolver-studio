use axum::{
    extract::{Extension, WebSocketUpgrade},
    response::IntoResponse,
};
use axum::extract::ws::{Message, WebSocket};
use tauri::Manager;

use super::event_bridge::WebEventBroadcaster;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Extension(app): Extension<tauri::AppHandle>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws_connection(socket, app))
}

async fn handle_ws_connection(mut socket: WebSocket, app: tauri::AppHandle) {
    let broadcaster = app.state::<WebEventBroadcaster>();
    let mut rx = broadcaster.subscribe();

    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        if let Ok(msg) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[WS] receiver lagged, skipped {n} events");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(_)) => {
                        // Client messages currently unused; reserved for future use
                    }
                    _ => break,
                }
            }
        }
    }
}
