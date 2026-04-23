use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ConnectionTrait, DatabaseConnection, DbBackend,
    EntityTrait, QueryOrder, Set, Statement,
};

use crate::db::entities::opened_tab;
use crate::db::error::DbError;
use crate::models::agent::AgentType;
use crate::models::OpenedTab;

fn parse_agent_type(s: &str) -> Option<AgentType> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

pub async fn list_all_tabs(conn: &DatabaseConnection) -> Result<Vec<OpenedTab>, DbError> {
    let rows = opened_tab::Entity::find()
        .order_by_asc(opened_tab::Column::Position)
        .all(conn)
        .await?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let agent_type = parse_agent_type(&r.agent_type)?;
            Some(OpenedTab {
                id: r.id,
                folder_id: r.folder_id,
                conversation_id: r.conversation_id,
                agent_type,
                position: r.position,
                is_active: r.is_active,
                is_pinned: r.is_pinned,
            })
        })
        .collect())
}

/// Replace all tabs with the given list (full replacement).
/// Ensures exactly one `is_active = true` (first active wins; others forced false).
pub async fn save_all_tabs(
    conn: &DatabaseConnection,
    items: Vec<OpenedTab>,
) -> Result<(), DbError> {
    opened_tab::Entity::delete_many().exec(conn).await?;

    if items.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let mut active_seen = false;

    for item in items {
        let agent_str = serde_json::to_value(item.agent_type)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();

        let is_active = if item.is_active && !active_seen {
            active_seen = true;
            true
        } else {
            false
        };

        let active = opened_tab::ActiveModel {
            id: NotSet,
            folder_id: Set(item.folder_id),
            conversation_id: Set(item.conversation_id),
            agent_type: Set(agent_str),
            position: Set(item.position),
            is_active: Set(is_active),
            is_pinned: Set(item.is_pinned),
            created_at: Set(now),
            updated_at: Set(now),
        };
        active.insert(conn).await?;
    }

    Ok(())
}

/// Delete all tabs that belong to a given folder (used when removing a folder
/// from the workspace).
pub async fn delete_tabs_for_folder(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<(), DbError> {
    let sql = format!("DELETE FROM opened_tab WHERE folder_id = {}", folder_id);
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;
    Ok(())
}
