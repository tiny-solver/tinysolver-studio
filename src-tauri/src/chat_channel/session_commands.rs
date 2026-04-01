use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;

use super::i18n::Lang;
use super::session_bridge::{ActiveSession, SessionBridge};
use super::types::RichMessage;
use crate::acp::manager::ConnectionManager;
use crate::acp::registry::all_acp_agents;
use crate::acp::types::PromptInputBlock;
use crate::db::entities::conversation;
use crate::db::service::{conversation_service, folder_service, sender_context_service};
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

// ── /folder ──

pub async fn handle_folder(
    db: &DatabaseConnection,
    args: &str,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    if args.is_empty() {
        return list_folders(db, channel_id, sender_id, lang).await;
    }

    // Try parse as index (1-based)
    if let Ok(idx) = args.parse::<usize>() {
        return select_folder_by_index(db, idx, channel_id, sender_id, lang).await;
    }

    // Treat as path
    select_folder_by_path(db, args, channel_id, sender_id, lang).await
}

async fn list_folders(
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let folders = match folder_service::list_folders(db).await {
        Ok(f) => f,
        Err(e) => return RichMessage::error(format!("Failed to list folders: {e}")),
    };

    if folders.is_empty() {
        return RichMessage::info(t(lang, "No folders found.", "没有找到项目目录。"))
            .with_title(t(lang, "Working Folder", "工作目录"));
    }

    let ctx = sender_context_service::get_or_create(db, channel_id, sender_id)
        .await
        .ok();

    let mut body = String::new();
    for (i, f) in folders.iter().take(10).enumerate() {
        let current = ctx
            .as_ref()
            .and_then(|c| c.current_folder_id)
            .map(|id| id == f.id)
            .unwrap_or(false);
        let marker = if current { " [*]" } else { "" };
        body.push_str(&format!(
            "{}. {}{} ({})\n",
            i + 1,
            f.name,
            marker,
            f.path
        ));
    }

    body.push_str(&format!(
        "\n{}",
        t(
            lang,
            "Reply /folder <number> to select.",
            "回复 /folder <数字> 选择目录。"
        )
    ));

    RichMessage::info(body.trim_end())
        .with_title(t(lang, "Working Folder", "工作目录"))
}

async fn select_folder_by_index(
    db: &DatabaseConnection,
    idx: usize,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    if idx == 0 {
        return RichMessage::info(t(lang, "Index starts from 1.", "序号从 1 开始。"));
    }

    let folders = match folder_service::list_folders(db).await {
        Ok(f) => f,
        Err(e) => return RichMessage::error(format!("Failed to list folders: {e}")),
    };

    let Some(folder) = folders.get(idx - 1) else {
        return RichMessage::info(t(
            lang,
            "Index out of range. Use /folder to list.",
            "序号超出范围，请使用 /folder 查看列表。",
        ));
    };

    let _ = sender_context_service::update_folder(db, channel_id, sender_id, Some(folder.id))
        .await;

    RichMessage::info(format!("{} ({})", folder.name, folder.path))
        .with_title(t(lang, "Folder Selected", "已选择目录"))
}

async fn select_folder_by_path(
    db: &DatabaseConnection,
    path: &str,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let entry = match folder_service::add_folder(db, path).await {
        Ok(e) => e,
        Err(e) => return RichMessage::error(format!("Failed to add folder: {e}")),
    };

    let _ =
        sender_context_service::update_folder(db, channel_id, sender_id, Some(entry.id)).await;

    RichMessage::info(format!("{} ({})", entry.name, entry.path))
        .with_title(t(lang, "Folder Selected", "已选择目录"))
}

// ── /agent ──

pub async fn handle_agent(
    db: &DatabaseConnection,
    args: &str,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    if args.is_empty() {
        return list_agents(db, channel_id, sender_id, lang).await;
    }

    // Try parse as index
    if let Ok(idx) = args.parse::<usize>() {
        return select_agent_by_index(db, idx, channel_id, sender_id, lang).await;
    }

    // Try parse as agent type name
    select_agent_by_name(db, args, channel_id, sender_id, lang).await
}

async fn list_agents(
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let agents = all_acp_agents();
    let ctx = sender_context_service::get_or_create(db, channel_id, sender_id)
        .await
        .ok();

    let mut body = String::new();
    for (i, at) in agents.iter().enumerate() {
        let at_str = agent_type_to_string(*at);
        let current = ctx
            .as_ref()
            .and_then(|c| c.current_agent_type.as_deref())
            .map(|s| s == at_str)
            .unwrap_or(false);
        let marker = if current { " [*]" } else { "" };
        body.push_str(&format!("{}. {}{}\n", i + 1, at, marker));
    }

    body.push_str(&format!(
        "\n{}",
        t(
            lang,
            "Reply /agent <number> or /agent <name> to select.",
            "回复 /agent <数字> 或 /agent <名称> 选择。"
        )
    ));

    RichMessage::info(body.trim_end())
        .with_title(t(lang, "Agent Selection", "选择 Agent"))
}

async fn select_agent_by_index(
    db: &DatabaseConnection,
    idx: usize,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let agents = all_acp_agents();
    if idx == 0 || idx > agents.len() {
        return RichMessage::info(t(
            lang,
            "Index out of range. Use /agent to list.",
            "序号超出范围，请使用 /agent 查看列表。",
        ));
    }

    let at = agents[idx - 1];
    let at_str = agent_type_to_string(at);
    let _ = sender_context_service::update_agent(db, channel_id, sender_id, Some(at_str)).await;

    RichMessage::info(at.to_string())
        .with_title(t(lang, "Agent Selected", "已选择 Agent"))
}

async fn select_agent_by_name(
    db: &DatabaseConnection,
    name: &str,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let at = match parse_agent_type(name) {
        Some(a) => a,
        None => {
            return RichMessage::info(format!(
                "{}{}",
                t(lang, "Unknown agent: ", "未知 Agent: "),
                name
            ));
        }
    };

    let at_str = agent_type_to_string(at);
    let _ = sender_context_service::update_agent(db, channel_id, sender_id, Some(at_str)).await;

    RichMessage::info(at.to_string())
        .with_title(t(lang, "Agent Selected", "已选择 Agent"))
}

// ── /task ──

#[allow(clippy::too_many_arguments)]
pub async fn handle_task(
    db: &DatabaseConnection,
    task_description: &str,
    channel_id: i32,
    sender_id: &str,
    conn_mgr: &ConnectionManager,
    emitter: &EventEmitter,
    bridge: &Arc<Mutex<SessionBridge>>,
    lang: Lang,
) -> RichMessage {
    if task_description.is_empty() {
        return RichMessage::info(t(
            lang,
            "Usage: /task <description>",
            "用法: /task <任务描述>",
        ));
    }

    // 1. Load sender context
    let ctx = match sender_context_service::get_or_create(db, channel_id, sender_id).await {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to load context: {e}")),
    };

    let folder_id = match ctx.current_folder_id {
        Some(id) => id,
        None => {
            return RichMessage::info(t(
                lang,
                "No folder selected. Use /folder first.",
                "未选择工作目录，请先使用 /folder 选择。",
            ));
        }
    };

    // 2. Get folder info
    let folder = match folder_service::get_folder_by_id(db, folder_id).await {
        Ok(Some(f)) => f,
        _ => {
            return RichMessage::info(t(
                lang,
                "Folder not found. Use /folder to select.",
                "目录不存在，请使用 /folder 重新选择。",
            ));
        }
    };

    // 3. Resolve agent type
    let agent_type = resolve_agent_type(&ctx.current_agent_type, &folder.default_agent_type);

    // 4. Create conversation record
    let conv = match conversation_service::create(
        db,
        folder_id,
        agent_type,
        Some(truncate_title(task_description)),
        folder.git_branch.clone(),
    )
    .await
    {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to create conversation: {e}")),
    };

    // 5. Spawn ACP agent
    let owner_label = format!("chat_channel:{}:{}", channel_id, sender_id);
    let connection_id = match conn_mgr
        .spawn_agent(
            agent_type,
            Some(folder.path.clone()),
            None,
            BTreeMap::new(),
            owner_label,
            emitter.clone(),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            // Clean up the conversation record
            let _ = conversation_service::update_status(
                db,
                conv.id,
                conversation::ConversationStatus::Cancelled,
            )
            .await;
            return RichMessage::error(format!(
                "{}{e}",
                t(lang, "Failed to start agent: ", "启动 Agent 失败: ")
            ));
        }
    };

    // 6. Register in bridge (prompt will be sent after SessionStarted event)
    {
        let session = ActiveSession {
            channel_id,
            sender_id: sender_id.to_string(),
            conversation_id: conv.id,
            connection_id: connection_id.clone(),
            content_buffer: String::new(),
            tool_calls: Vec::new(),
            last_flushed: Instant::now(),
            pending_prompt: Some(task_description.to_string()),
            permission_pending: None,
        };
        bridge.lock().await.register(connection_id.clone(), session);
    }

    // 7. Update sender context
    let _ = sender_context_service::update_session(
        db,
        channel_id,
        sender_id,
        Some(conv.id),
        Some(connection_id),
    )
    .await;

    RichMessage::info(format!(
        "[{}] #{} @ {}",
        agent_type, conv.id, folder.name,
    ))
    .with_title(t(lang, "Task Started", "任务已启动"))
}

// ── /sessions ──

pub async fn handle_sessions(
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    lang: Lang,
) -> RichMessage {
    let ctx = match sender_context_service::get_or_create(db, channel_id, sender_id).await {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to load context: {e}")),
    };

    let folder_id = match ctx.current_folder_id {
        Some(id) => id,
        None => {
            return RichMessage::info(t(
                lang,
                "No folder selected. Use /folder first.",
                "未选择工作目录，请先使用 /folder 选择。",
            ));
        }
    };

    let folder = match folder_service::get_folder_by_id(db, folder_id).await {
        Ok(Some(f)) => f,
        _ => {
            return RichMessage::info(t(
                lang,
                "Folder not found.",
                "目录不存在。",
            ));
        }
    };

    let convs = match conversation_service::list_by_folder(
        db,
        folder_id,
        None,
        None,
        None,
        Some("in_progress".to_string()),
    )
    .await
    {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to list sessions: {e}")),
    };

    if convs.is_empty() {
        return RichMessage::info(t(
            lang,
            "No active sessions in this folder.",
            "当前目录没有进行中的会话。",
        ))
        .with_title(format!(
            "{} - {}",
            t(lang, "Sessions", "会话列表"),
            folder.name
        ));
    }

    let mut body = String::new();
    for (i, c) in convs.iter().take(10).enumerate() {
        let title = c.title.as_deref().unwrap_or("(untitled)");
        let current = ctx
            .current_conversation_id
            .map(|id| id == c.id)
            .unwrap_or(false);
        let marker = if current { " [*]" } else { "" };
        body.push_str(&format!(
            "{}. [{}] {} (#{}){}  \n",
            i + 1,
            c.agent_type,
            title,
            c.id,
            marker,
        ));
    }

    body.push_str(&format!(
        "\n{}",
        t(
            lang,
            "Reply /resume <id> to continue.",
            "回复 /resume <ID> 继续会话。"
        )
    ));

    RichMessage::info(body.trim_end()).with_title(format!(
        "{} - {}",
        t(lang, "Sessions", "会话列表"),
        folder.name
    ))
}

// ── /resume ──

#[allow(clippy::too_many_arguments)]
pub async fn handle_resume(
    db: &DatabaseConnection,
    args: &str,
    channel_id: i32,
    sender_id: &str,
    conn_mgr: &ConnectionManager,
    emitter: &EventEmitter,
    bridge: &Arc<Mutex<SessionBridge>>,
    lang: Lang,
) -> RichMessage {
    let conversation_id: i32 = match args.parse() {
        Ok(id) => id,
        Err(_) => {
            return RichMessage::info(t(
                lang,
                "Usage: /resume <conversation_id>",
                "用法: /resume <会话ID>",
            ));
        }
    };

    let conv = match conversation_service::get_by_id(db, conversation_id).await {
        Ok(c) => c,
        Err(_) => {
            return RichMessage::info(t(
                lang,
                "Conversation not found.",
                "会话不存在。",
            ));
        }
    };

    let folder = match folder_service::get_folder_by_id(db, conv.folder_id).await {
        Ok(Some(f)) => f,
        _ => {
            return RichMessage::info(t(lang, "Folder not found.", "目录不存在。"));
        }
    };

    // Spawn agent with session_id for resume
    let owner_label = format!("chat_channel:{}:{}", channel_id, sender_id);
    let connection_id = match conn_mgr
        .spawn_agent(
            conv.agent_type,
            Some(folder.path.clone()),
            conv.external_id.clone(),
            BTreeMap::new(),
            owner_label,
            emitter.clone(),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            return RichMessage::error(format!(
                "{}{e}",
                t(lang, "Failed to start agent: ", "启动 Agent 失败: ")
            ));
        }
    };

    // Register in bridge (no pending prompt for resume)
    {
        let session = ActiveSession {
            channel_id,
            sender_id: sender_id.to_string(),
            conversation_id: conv.id,
            connection_id: connection_id.clone(),
            content_buffer: String::new(),
            tool_calls: Vec::new(),
            last_flushed: Instant::now(),
            pending_prompt: None,
            permission_pending: None,
        };
        bridge.lock().await.register(connection_id.clone(), session);
    }

    // Update sender context
    let _ = sender_context_service::update_session(
        db,
        channel_id,
        sender_id,
        Some(conv.id),
        Some(connection_id),
    )
    .await;
    let _ = sender_context_service::update_folder(db, channel_id, sender_id, Some(conv.folder_id))
        .await;

    let title = conv.title.as_deref().unwrap_or("(untitled)");
    RichMessage::info(format!(
        "[{}] #{} {} @ {}",
        conv.agent_type, conv.id, title, folder.name,
    ))
    .with_title(t(lang, "Session Resumed", "会话已恢复"))
}

// ── /cancel ──

pub async fn handle_cancel(
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    conn_mgr: &ConnectionManager,
    bridge: &Arc<Mutex<SessionBridge>>,
    lang: Lang,
) -> RichMessage {
    let ctx = match sender_context_service::get_or_create(db, channel_id, sender_id).await {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to load context: {e}")),
    };

    let connection_id = match &ctx.current_connection_id {
        Some(id) => id.clone(),
        None => {
            return RichMessage::info(t(
                lang,
                "No active session to cancel.",
                "没有进行中的任务可取消。",
            ));
        }
    };

    // Cancel the ACP connection
    let _ = conn_mgr.cancel(&connection_id).await;

    // Remove from bridge
    bridge.lock().await.remove(&connection_id);

    // Update conversation status
    if let Some(conv_id) = ctx.current_conversation_id {
        let _ = conversation_service::update_status(
            db,
            conv_id,
            conversation::ConversationStatus::Cancelled,
        )
        .await;
    }

    // Clear session from context
    let _ = sender_context_service::clear_session(db, channel_id, sender_id).await;

    RichMessage::info(t(
        lang,
        "Current task has been cancelled.",
        "当前任务已取消。",
    ))
    .with_title(t(lang, "Task Cancelled", "任务已取消"))
}

// ── /approve, /deny ──

#[allow(clippy::too_many_arguments)]
pub async fn handle_permission_response(
    approve: bool,
    always: bool,
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    conn_mgr: &ConnectionManager,
    bridge: &Arc<Mutex<SessionBridge>>,
    lang: Lang,
) -> RichMessage {
    let ctx = match sender_context_service::get_or_create(db, channel_id, sender_id).await {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to load context: {e}")),
    };

    let connection_id = match &ctx.current_connection_id {
        Some(id) => id.clone(),
        None => {
            return RichMessage::info(t(
                lang,
                "No active session.",
                "没有活跃的会话。",
            ));
        }
    };

    let pending = {
        let mut bridge_guard = bridge.lock().await;
        let session = match bridge_guard.get_mut(&connection_id) {
            Some(s) => s,
            None => {
                return RichMessage::info(t(
                    lang,
                    "No active session found.",
                    "未找到活跃的会话。",
                ));
            }
        };
        session.permission_pending.take()
    };

    let pending = match pending {
        Some(p) => p,
        None => {
            return RichMessage::info(t(
                lang,
                "No pending permission request.",
                "没有待处理的权限请求。",
            ));
        }
    };

    // Find the appropriate option_id
    let option_id = if approve {
        pending
            .options
            .iter()
            .find(|o| o.kind == "allow" || o.kind == "allowForSession")
            .or_else(|| pending.options.first())
            .map(|o| o.option_id.clone())
    } else {
        pending
            .options
            .iter()
            .find(|o| o.kind == "deny")
            .or_else(|| pending.options.last())
            .map(|o| o.option_id.clone())
    };

    let Some(option_id) = option_id else {
        return RichMessage::info(t(
            lang,
            "No valid permission option found.",
            "未找到有效的权限选项。",
        ));
    };

    if let Err(e) = conn_mgr
        .respond_permission(&connection_id, &pending.request_id, &option_id)
        .await
    {
        return RichMessage::error(format!(
            "{}{e}",
            t(
                lang,
                "Failed to respond to permission: ",
                "权限响应失败: "
            )
        ));
    }

    // Update auto_approve if requested
    if always && approve {
        let _ =
            sender_context_service::update_auto_approve(db, channel_id, sender_id, true).await;
    }

    let action = if approve {
        t(lang, "Approved", "已批准")
    } else {
        t(lang, "Denied", "已拒绝")
    };

    let mut msg = RichMessage::info(format!("{}: {}", action, pending.tool_description));
    if always && approve {
        msg = msg.with_field(
            "",
            t(
                lang,
                "Auto-approve enabled for this session.",
                "已启用自动批准。",
            ),
        );
    }
    msg.with_title(t(lang, "Permission Response", "权限响应"))
}

// ── follow-up (non-command text) ──

pub async fn handle_followup(
    db: &DatabaseConnection,
    text: &str,
    channel_id: i32,
    sender_id: &str,
    conn_mgr: &ConnectionManager,
    bridge: &Arc<Mutex<SessionBridge>>,
    lang: Lang,
) -> RichMessage {
    let ctx = match sender_context_service::get_or_create(db, channel_id, sender_id).await {
        Ok(c) => c,
        Err(e) => return RichMessage::error(format!("Failed to load context: {e}")),
    };

    let connection_id = match &ctx.current_connection_id {
        Some(id) => id.clone(),
        None => {
            return RichMessage::info(t(
                lang,
                "No active session. Use /task to start one.",
                "没有活跃的会话，请使用 /task 开始新任务。",
            ));
        }
    };

    // Check connection exists in bridge
    {
        let bridge_guard = bridge.lock().await;
        if bridge_guard.get(&connection_id).is_none() {
            // Connection lost, clear context
            drop(bridge_guard);
            let _ = sender_context_service::clear_session(db, channel_id, sender_id).await;
            return RichMessage::info(t(
                lang,
                "Session connection lost. Use /task to start a new one.",
                "会话连接已断开，请使用 /task 开始新任务。",
            ));
        }
    }

    // Send prompt to agent
    let blocks = vec![PromptInputBlock::Text {
        text: text.to_string(),
    }];

    if let Err(e) = conn_mgr.send_prompt(&connection_id, blocks).await {
        // Connection may have died
        bridge.lock().await.remove(&connection_id);
        let _ = sender_context_service::clear_session(db, channel_id, sender_id).await;
        return RichMessage::error(format!(
            "{}{e}",
            t(lang, "Failed to send message: ", "发送消息失败: ")
        ));
    }

    RichMessage::info(t(lang, "Message sent.", "消息已发送。"))
}

// ── Helpers ──

fn t(lang: Lang, en: &str, zh: &str) -> String {
    match lang {
        Lang::ZhCn | Lang::ZhTw => zh.to_string(),
        _ => en.to_string(),
    }
}

fn agent_type_to_string(at: AgentType) -> String {
    serde_json::to_value(at)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

fn parse_agent_type(name: &str) -> Option<AgentType> {
    let normalized = name.to_lowercase().replace([' ', '-'], "_");
    serde_json::from_value(serde_json::Value::String(normalized)).ok()
}

fn resolve_agent_type(
    sender_agent: &Option<String>,
    folder_default: &Option<AgentType>,
) -> AgentType {
    if let Some(ref at_str) = sender_agent {
        if let Some(at) = parse_agent_type(at_str) {
            return at;
        }
    }
    if let Some(at) = folder_default {
        return *at;
    }
    AgentType::ClaudeCode
}

fn truncate_title(s: &str) -> String {
    if s.len() <= 80 {
        s.to_string()
    } else {
        format!("{}...", &s[..77])
    }
}
