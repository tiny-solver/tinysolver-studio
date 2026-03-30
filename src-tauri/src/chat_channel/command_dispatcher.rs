use sea_orm::DatabaseConnection;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::command_handlers;
use super::manager::ChatChannelManager;
use super::types::IncomingCommand;
use crate::db::service::chat_channel_message_log_service;

pub fn spawn_command_dispatcher(
    mut command_rx: mpsc::Receiver<IncomingCommand>,
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(cmd) = command_rx.recv().await {
            let text = cmd.command_text.trim();

            // Log inbound command
            let _ = chat_channel_message_log_service::create_log(
                &db_conn,
                cmd.channel_id,
                "inbound",
                "command_query",
                text,
                "sent",
                None,
            )
            .await;

            let response = dispatch_command(text, &db_conn, &manager).await;

            // Send response back via the same channel
            let send_result = manager.send_to_channel(cmd.channel_id, &response).await;
            let (status, error_detail) = match &send_result {
                Ok(_) => ("sent", None),
                Err(e) => ("failed", Some(e.to_string())),
            };

            let _ = chat_channel_message_log_service::create_log(
                &db_conn,
                cmd.channel_id,
                "outbound",
                "command_response",
                &response.to_plain_text(),
                status,
                error_detail,
            )
            .await;
        }
    })
}

async fn dispatch_command(
    text: &str,
    db: &DatabaseConnection,
    manager: &ChatChannelManager,
) -> super::types::RichMessage {
    let parts: Vec<&str> = text.splitn(2, ' ').collect();
    let command = parts[0].to_lowercase();
    let args = parts.get(1).map(|s| s.trim()).unwrap_or("");

    match command.as_str() {
        "/recent" => command_handlers::handle_recent(db).await,
        "/search" => {
            if args.is_empty() {
                super::types::RichMessage::info("用法: /search <关键词>")
                    .with_title("参数错误")
            } else {
                command_handlers::handle_search(db, args).await
            }
        }
        "/detail" => {
            if let Ok(id) = args.parse::<i32>() {
                command_handlers::handle_detail(db, id).await
            } else {
                super::types::RichMessage::info("用法: /detail <会话ID>")
                    .with_title("参数错误")
            }
        }
        "/today" => command_handlers::handle_today(db).await,
        "/status" => command_handlers::handle_status(manager).await,
        "/help" | "/start" => command_handlers::handle_help(),
        _ => {
            if text.starts_with('/') {
                super::types::RichMessage::info(format!(
                    "未知命令: {}\n输入 /help 查看可用命令",
                    command
                ))
                .with_title("未知命令")
            } else {
                // Non-command messages are ignored
                return command_handlers::handle_help();
            }
        }
    }
}
