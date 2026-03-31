use super::i18n::{self, Lang};
use super::types::{MessageLevel, RichMessage};

pub fn format_turn_complete(agent_type: &str, stop_reason: &str, lang: Lang) -> RichMessage {
    let reason = match stop_reason {
        "end_turn" => i18n::stop_reason_end_turn(lang),
        "cancelled" => i18n::stop_reason_cancelled(lang),
        _ => stop_reason,
    };
    RichMessage::info(i18n::turn_complete_body(lang, agent_type))
        .with_title(i18n::turn_complete_title(lang))
        .with_field(i18n::stop_reason_label(lang), reason)
}

pub fn format_agent_error(agent_type: &str, message: &str, lang: Lang) -> RichMessage {
    RichMessage {
        title: Some(i18n::agent_error_title(lang).to_string()),
        body: i18n::agent_error_body(lang, agent_type),
        fields: vec![(
            i18n::error_message_label(lang).to_string(),
            message.to_string(),
        )],
        level: MessageLevel::Error,
    }
}

pub struct DailyReportData {
    pub date: String,
    pub conversations_by_agent: Vec<(String, u32)>,
    pub total_conversations: u32,
    pub projects_involved: Vec<String>,
    pub key_activities: Vec<String>,
}

pub fn format_daily_report(report: &DailyReportData, lang: Lang) -> RichMessage {
    let mut body = i18n::daily_report_summary(lang, &report.date);

    body.push_str(&format!(
        "\n\n{}",
        i18n::total_sessions(lang, report.total_conversations)
    ));

    if !report.conversations_by_agent.is_empty() {
        body.push_str(&format!("\n\n{}", i18n::by_agent_label(lang)));
        for (agent, count) in &report.conversations_by_agent {
            body.push_str(&format!(
                "\n  {}",
                i18n::agent_session_count(lang, agent, *count)
            ));
        }
    }

    if !report.projects_involved.is_empty() {
        body.push_str(&format!(
            "\n\n{}",
            i18n::projects_label(lang, &report.projects_involved.join(", "))
        ));
    }

    if !report.key_activities.is_empty() {
        body.push_str(&format!("\n\n{}", i18n::key_activities_label(lang)));
        for activity in &report.key_activities {
            body.push_str(&format!("\n  • {}", activity));
        }
    }

    RichMessage::info(body).with_title(i18n::daily_report_title(lang))
}
