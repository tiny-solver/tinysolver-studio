use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{Extension, WebSocketUpgrade},
    response::IntoResponse,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::shutdown::ShutdownSignal;
use super::ws_attach::{
    self, ClientMsg, DetachReason, ServerMsg, OUTBOUND_CAPACITY,
};
use crate::app_state::AppState;

// MUST match `WS_READY_CHANNEL` in `src/lib/transport/constants.ts`.
// Drift between the two values silently breaks the handshake (the client
// keeps waiting and falls back to the timeout warning path after 5 s).
//
// Phase 1: kept active in parallel with the new attach protocol so existing
// clients (web / remote desktop) continue to work while transports migrate.
// Phase 4 will retire this channel.
const WS_READY_CHANNEL: &str = "__ready__";

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Extension(state): Extension<Arc<AppState>>,
    Extension(shutdown_signal): Extension<Arc<ShutdownSignal>>,
) -> impl IntoResponse {
    ws.protocols([super::auth::WS_EVENT_PROTOCOL])
        .on_upgrade(|socket| handle_ws_connection(socket, state, shutdown_signal))
}

async fn handle_ws_connection(
    mut socket: WebSocket,
    state: Arc<AppState>,
    shutdown_signal: Arc<ShutdownSignal>,
) {
    // Late handshake guard: if shutdown already fired before this task
    // even started, exit before subscribing to anything else.
    if shutdown_signal.is_triggered() {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    // Legacy global firehose subscriber. Removed in Phase 4 once all
    // transports use the attach protocol.
    let mut global_rx = state.event_broadcaster.subscribe();

    // Outbound channel funnels every server-→-client frame through one
    // sender so the WS write side has a single owner. Per-attach forwarder
    // tasks push `Event`/`Detached` frames here; the main loop pushes
    // `Snapshot`/`Replay`/`Pong` directly.
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<ServerMsg>(OUTBOUND_CAPACITY);

    // Track active attach subscriptions on this socket so a `detach`
    // message can abort the matching forwarder task and so we can clean
    // them all up on socket close.
    let mut subscriptions: HashMap<String, JoinHandle<()>> = HashMap::new();

    // Server→client ready handshake (legacy `__ready__` frame). Phase 1
    // keeps this so unmigrated transports still gate `acp_connect` on the
    // server-side receiver being subscribed. New attach-protocol clients
    // ignore this frame (channel name doesn't match any attach payload).
    let ready_payload = serde_json::json!({
        "channel": WS_READY_CHANNEL,
        "payload": null,
    });
    match serde_json::to_string(&ready_payload) {
        Ok(text) => {
            if let Err(e) = socket.send(Message::Text(text.into())).await {
                eprintln!("[WS][WARN] failed to send __ready__ frame: {e}");
                return;
            }
        }
        Err(e) => {
            eprintln!("[WS][WARN] failed to serialize __ready__ frame: {e}");
            return;
        }
    }

    loop {
        tokio::select! {
            // Server-initiated shutdown: notify any active attach
            // subscriptions before closing so the client can decide
            // whether to retry on the next reconnect.
            _ = shutdown_signal.wait() => {
                for sub_id in subscriptions.keys() {
                    let frame = ServerMsg::Detached {
                        subscription_id: sub_id.clone(),
                        reason: DetachReason::ServerShutdown,
                    };
                    if let Ok(text) = serde_json::to_string(&frame) {
                        let _ = socket.send(Message::Text(text.into())).await;
                    }
                }
                let _ = socket.send(Message::Close(None)).await;
                break;
            }

            // Outbound queue (per-attach forwarders + main-loop direct sends).
            outgoing = outbound_rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        match serde_json::to_string(&msg) {
                            Ok(text) => {
                                if socket.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                eprintln!("[WS][WARN] failed to serialize ServerMsg: {e}");
                            }
                        }
                    }
                    // Channel closed only when all senders dropped — i.e. this
                    // task itself dropped `outbound_tx` AND every spawned
                    // forwarder exited. Won't happen while the loop runs.
                    None => break,
                }
            }

            // Legacy global firehose. Forwarded as-is (uses the old
            // `WebEvent { channel, payload }` shape, not the attach
            // protocol's `ServerMsg`).
            result = global_rx.recv() => {
                match result {
                    Ok(event) => {
                        if let Ok(msg) = serde_json::to_string(&event) {
                            if socket.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[WS][WARN] global receiver lagged, skipped {n} events");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            // Client-→-server messages. Text frames are parsed as
            // `ClientMsg`; everything else is ignored (binary, ping/pong
            // are handled by axum, close is handled by the None match arm).
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ClientMsg>(&text) {
                            Ok(cmsg) => {
                                handle_client_msg(
                                    cmsg,
                                    &state,
                                    &outbound_tx,
                                    &mut subscriptions,
                                ).await;
                            }
                            Err(e) => {
                                eprintln!("[WS][WARN] malformed client message: {e}");
                            }
                        }
                    }
                    Some(Ok(_)) => {
                        // Binary / ping / pong: ignore.
                    }
                    _ => break,
                }
            }
        }
    }

    // Cleanup: abort all active forwarder tasks. Their broadcast receivers
    // will be dropped, freeing the per-connection broadcaster slot.
    for (_, handle) in subscriptions.drain() {
        handle.abort();
    }
}

async fn handle_client_msg(
    msg: ClientMsg,
    state: &Arc<AppState>,
    outbound_tx: &mpsc::Sender<ServerMsg>,
    subscriptions: &mut HashMap<String, JoinHandle<()>>,
) {
    match msg {
        ClientMsg::Attach {
            subscription_id,
            connection_id,
            since_seq,
        } => {
            // Re-attach with the same subscription_id replaces the prior
            // forwarder. Abort the old one first so its receiver drops
            // and we don't leak a broadcaster slot.
            if let Some(old) = subscriptions.remove(&subscription_id) {
                old.abort();
            }

            match ws_attach::handle_attach(
                &state.connection_manager,
                state.acp_event_bus.metrics(),
                subscription_id.clone(),
                connection_id,
                since_seq,
            )
            .await
            {
                Ok(outcome) => {
                    // Send the initial frame (snapshot or replay) BEFORE
                    // spawning the forwarder so the client sees state
                    // before the first live event.
                    if outbound_tx.send(outcome.initial_msg).await.is_err() {
                        return;
                    }
                    let handle = ws_attach::spawn_forwarder(
                        subscription_id.clone(),
                        state.acp_event_bus.metrics().clone(),
                        outcome.receiver,
                        outbound_tx.clone(),
                    );
                    subscriptions.insert(subscription_id, handle);
                }
                Err(reason) => {
                    let _ = outbound_tx
                        .send(ServerMsg::Detached {
                            subscription_id,
                            reason,
                        })
                        .await;
                }
            }
        }
        ClientMsg::Detach { subscription_id } => {
            if let Some(handle) = subscriptions.remove(&subscription_id) {
                handle.abort();
            }
        }
        ClientMsg::Ping => {
            let _ = outbound_tx.send(ServerMsg::Pong).await;
        }
    }
}
