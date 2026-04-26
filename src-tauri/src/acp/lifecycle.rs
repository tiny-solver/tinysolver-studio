//! Background subscriber that watches the global `acp://event` broadcaster
//! for events that need cross-connection DB persistence (e.g. binding the
//! agent's external session id onto a conversation row when SessionStarted
//! fires). Decoupled from `emit_with_state` so the emit hot path stays
//! lock-tight.

use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::broadcast;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope};
use crate::db::error::DbError;
use crate::db::service::conversation_service;
use crate::web::event_bridge::{WebEvent, WebEventBroadcaster};

pub(crate) async fn handle_event(
    db_conn: &DatabaseConnection,
    manager: &ConnectionManager,
    envelope: &EventEnvelope,
) -> Result<(), DbError> {
    match &envelope.payload {
        AcpEvent::SessionStarted { session_id } => {
            // Look up conversation_id from the live state.
            let Some(state_arc) = manager.get_state(&envelope.connection_id).await else {
                return Ok(());
            };
            let conversation_id = state_arc.read().await.conversation_id;
            if let Some(cid) = conversation_id {
                conversation_service::update_external_id(db_conn, cid, session_id.clone())
                    .await?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn spawn_lifecycle_subscriber(
    db_conn: DatabaseConnection,
    manager: ConnectionManager,
    broadcaster: Arc<WebEventBroadcaster>,
) {
    let mut rx = broadcaster.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(WebEvent { channel, payload }) => {
                    if channel != "acp://event" {
                        continue;
                    }
                    let envelope: EventEnvelope = match serde_json::from_value((*payload).clone()) {
                        Ok(env) => env,
                        Err(e) => {
                            eprintln!("[lifecycle] failed to parse envelope: {e}");
                            continue;
                        }
                    };
                    if let Err(e) = handle_event(&db_conn, &manager, &envelope).await {
                        eprintln!(
                            "[lifecycle] DB write failed for {:?}: {e}",
                            envelope.payload
                        );
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("[lifecycle] broadcaster lagged, dropped {skipped} events");
                }
                Err(broadcast::error::RecvError::Closed) => {
                    eprintln!("[lifecycle] broadcaster closed; subscriber exiting");
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_state::SessionState;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::EventEmitter;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    fn fake_connection_with_state(
        id: &str,
        conv_id: Option<i32>,
    ) -> crate::acp::connection::AgentConnection {
        let (tx, _rx) = mpsc::channel(1);
        let mut state = SessionState::new(
            id.to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = conv_id;
        crate::acp::connection::AgentConnection {
            id: id.to_string(),
            agent_type: AgentType::ClaudeCode,
            status: crate::acp::types::ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
        }
    }

    #[tokio::test]
    async fn handle_event_writes_external_id_when_conversation_bound() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "ext-99".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env).await.unwrap();
        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.external_id.as_deref(), Some("ext-99"));
    }

    #[tokio::test]
    async fn handle_event_is_noop_when_no_conversation_bound() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c1".to_string(), fake_connection_with_state("c1", None));
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "ignored".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env).await.unwrap();
    }

    #[tokio::test]
    async fn handle_event_is_noop_for_unrelated_events() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::ContentDelta { text: "hi".into() },
        };
        handle_event(&db.conn, &mgr, &env).await.unwrap();
    }
}
