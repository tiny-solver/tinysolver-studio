use super::types::{MessageLevel, RichMessage};

pub fn format_session_started(agent_type: &str, folder_name: &str) -> RichMessage {
    RichMessage::info(format!("{agent_type} 在 {folder_name} 开始了新会话"))
        .with_title("新会话")
}

pub fn format_turn_complete(agent_type: &str, stop_reason: &str) -> RichMessage {
    let reason = match stop_reason {
        "end_turn" => "正常结束",
        "cancelled" => "已取消",
        _ => stop_reason,
    };
    RichMessage::info(format!("{agent_type} 会话已完成"))
        .with_title("会话完成")
        .with_field("结束原因", reason)
}

pub fn format_agent_error(agent_type: &str, message: &str) -> RichMessage {
    RichMessage {
        title: Some("代理错误".to_string()),
        body: format!("{agent_type} 发生错误"),
        fields: vec![("错误信息".to_string(), message.to_string())],
        level: MessageLevel::Error,
    }
}

pub fn format_agent_disconnected(agent_type: &str) -> RichMessage {
    RichMessage {
        title: Some("代理断开".to_string()),
        body: format!("{agent_type} 已断开连接"),
        fields: Vec::new(),
        level: MessageLevel::Warning,
    }
}

pub fn format_git_push(folder_name: &str, branch: &str, commits: u32) -> RichMessage {
    RichMessage::info(format!(
        "Git Push 成功: {commits} 个提交推送到 {branch}"
    ))
    .with_title("Git Push")
    .with_field("项目", folder_name)
}

pub fn format_git_commit(folder_name: &str, files: u32) -> RichMessage {
    RichMessage::info(format!("Git Commit: {files} 个文件已提交"))
        .with_title("Git Commit")
        .with_field("项目", folder_name)
}

pub struct DailyReportData {
    pub date: String,
    pub conversations_by_agent: Vec<(String, u32)>,
    pub total_conversations: u32,
    pub projects_involved: Vec<String>,
    pub key_activities: Vec<String>,
}

pub fn format_daily_report(report: &DailyReportData) -> RichMessage {
    let mut body = format!("今日编码活动汇总 ({})", report.date);

    body.push_str(&format!("\n\n会话总数: {}", report.total_conversations));

    if !report.conversations_by_agent.is_empty() {
        body.push_str("\n\n按代理分布:");
        for (agent, count) in &report.conversations_by_agent {
            body.push_str(&format!("\n  {} - {} 个会话", agent, count));
        }
    }

    if !report.projects_involved.is_empty() {
        body.push_str(&format!(
            "\n\n涉及项目: {}",
            report.projects_involved.join(", ")
        ));
    }

    if !report.key_activities.is_empty() {
        body.push_str("\n\n主要活动:");
        for activity in &report.key_activities {
            body.push_str(&format!("\n  • {}", activity));
        }
    }

    RichMessage::info(body).with_title("每日编码报告")
}
