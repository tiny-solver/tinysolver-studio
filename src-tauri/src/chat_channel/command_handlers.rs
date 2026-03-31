use chrono::Utc;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};

use super::i18n::{self, Lang};
use super::manager::ChatChannelManager;
use super::types::{MessageLevel, RichMessage};
use crate::db::entities::conversation;

pub async fn handle_recent(db: &DatabaseConnection, lang: Lang) -> RichMessage {
    let rows = match conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .order_by_desc(conversation::Column::CreatedAt)
        .all(db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    let recent: Vec<_> = rows.into_iter().take(5).collect();
    if recent.is_empty() {
        return RichMessage::info(i18n::no_conversations(lang))
            .with_title(i18n::recent_conversations_title(lang));
    }

    let mut body = String::new();
    for (i, conv) in recent.iter().enumerate() {
        let title = conv.title.as_deref().unwrap_or(i18n::untitled(lang));
        let agent = &conv.agent_type;
        let time = conv.created_at.format("%m-%d %H:%M");
        body.push_str(&format!(
            "{}. [{}] {} ({})\n",
            i + 1,
            agent,
            title,
            time
        ));
    }

    RichMessage::info(body.trim_end())
        .with_title(i18n::recent_n_conversations_title(lang, recent.len()))
}

pub async fn handle_search(
    db: &DatabaseConnection,
    keyword: &str,
    lang: Lang,
) -> RichMessage {
    let rows = match conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .order_by_desc(conversation::Column::CreatedAt)
        .all(db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    let keyword_lower = keyword.to_lowercase();
    let matched: Vec<_> = rows
        .into_iter()
        .filter(|c| {
            c.title
                .as_deref()
                .map(|t| t.to_lowercase().contains(&keyword_lower))
                .unwrap_or(false)
        })
        .take(10)
        .collect();

    if matched.is_empty() {
        return RichMessage::info(i18n::search_no_results(lang, keyword))
            .with_title(i18n::search_results_title(lang));
    }

    let mut body = String::new();
    for (i, conv) in matched.iter().enumerate() {
        let title = conv.title.as_deref().unwrap_or(i18n::untitled(lang));
        let agent = &conv.agent_type;
        body.push_str(&format!(
            "{}. [{}] {} (ID:{})\n",
            i + 1,
            agent,
            title,
            conv.id
        ));
    }

    RichMessage::info(body.trim_end()).with_title(i18n::search_results_count_title(
        lang,
        keyword,
        matched.len(),
    ))
}

pub async fn handle_detail(
    db: &DatabaseConnection,
    conversation_id: i32,
    lang: Lang,
) -> RichMessage {
    let conv = match conversation::Entity::find_by_id(conversation_id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(db)
        .await
    {
        Ok(Some(c)) => c,
        Ok(None) => {
            return RichMessage::info(i18n::conversation_not_found(lang, conversation_id))
                .with_title(i18n::not_found_title(lang));
        }
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    let title = conv.title.as_deref().unwrap_or(i18n::untitled(lang));
    RichMessage::info(title)
        .with_title(i18n::conversation_detail_title(lang, conv.id))
        .with_field(i18n::field_agent(lang), &conv.agent_type)
        .with_field(i18n::field_status(lang), format!("{:?}", conv.status))
        .with_field(
            i18n::field_message_count(lang),
            conv.message_count.to_string(),
        )
        .with_field(
            i18n::field_created_at(lang),
            conv.created_at.format("%Y-%m-%d %H:%M").to_string(),
        )
}

pub async fn handle_today(db: &DatabaseConnection, lang: Lang) -> RichMessage {
    let now = Utc::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();

    let rows = match conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::CreatedAt.gte(today_start))
        .order_by_desc(conversation::Column::CreatedAt)
        .all(db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    if rows.is_empty() {
        return RichMessage::info(i18n::no_activity_today(lang))
            .with_title(i18n::today_activity_title(lang));
    }

    // Group by agent_type
    let mut by_agent: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut titles: Vec<String> = Vec::new();
    for conv in &rows {
        *by_agent.entry(conv.agent_type.clone()).or_insert(0) += 1;
        if let Some(t) = &conv.title {
            if titles.len() < 5 {
                titles.push(t.clone());
            }
        }
    }

    let mut body = i18n::total_sessions(lang, rows.len() as u32);
    body.push_str(&format!("\n\n{}", i18n::by_agent_label(lang)));
    for (agent, count) in &by_agent {
        body.push_str(&format!(
            "\n  {}",
            i18n::agent_count(lang, agent, *count)
        ));
    }

    if !titles.is_empty() {
        body.push_str(&format!("\n\n{}", i18n::recent_activity_label(lang)));
        for t in &titles {
            body.push_str(&format!("\n  • {t}"));
        }
    }

    RichMessage::info(body).with_title(i18n::today_activity_date_title(
        lang,
        &now.format("%Y-%m-%d").to_string(),
    ))
}

pub async fn handle_status(manager: &ChatChannelManager, lang: Lang) -> RichMessage {
    let statuses = manager.get_status().await;
    if statuses.is_empty() {
        return RichMessage::info(i18n::no_active_channels(lang))
            .with_title(i18n::channel_status_title(lang));
    }

    let mut body = String::new();
    for s in &statuses {
        let icon = match s.status.as_str() {
            "connected" => "●",
            "connecting" => "◎",
            "error" => "✗",
            _ => "○",
        };
        body.push_str(&format!(
            "{} {} [{}] - {}\n",
            icon, s.name, s.channel_type, s.status
        ));
    }

    RichMessage::info(body.trim_end()).with_title(i18n::channel_status_title(lang))
}

pub fn handle_help(prefix: &str, lang: Lang) -> RichMessage {
    RichMessage::info(i18n::help_body(lang, prefix)).with_title(i18n::help_title(lang))
}
