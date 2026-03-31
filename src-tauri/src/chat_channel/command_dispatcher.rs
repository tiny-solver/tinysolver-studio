use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::command_handlers;
use super::i18n::{self, Lang};
use super::manager::ChatChannelManager;
use super::types::IncomingCommand;
use crate::db::service::{app_metadata_service, chat_channel_message_log_service};

const COMMAND_PREFIX_KEY: &str = "chat_command_prefix";
const DEFAULT_COMMAND_PREFIX: &str = "/";
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";
/// How often to refresh cached config from DB.
const CONFIG_CACHE_TTL_SECS: u64 = 30;

struct CommandConfigCache {
    prefix: String,
    lang: Lang,
    last_refresh: Instant,
}

impl CommandConfigCache {
    fn new() -> Self {
        Self {
            prefix: DEFAULT_COMMAND_PREFIX.to_string(),
            lang: Lang::default(),
            // Force refresh on first use
            last_refresh: Instant::now() - Duration::from_secs(CONFIG_CACHE_TTL_SECS + 1),
        }
    }

    async fn refresh_if_needed(&mut self, db: &DatabaseConnection) {
        if self.last_refresh.elapsed() < Duration::from_secs(CONFIG_CACHE_TTL_SECS) {
            return;
        }

        if let Ok(Some(val)) = app_metadata_service::get_value(db, COMMAND_PREFIX_KEY).await {
            self.prefix = val;
        }
        if let Ok(Some(val)) = app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY).await {
            self.lang = Lang::from_str_lossy(&val);
        }

        self.last_refresh = Instant::now();
    }
}

pub fn spawn_command_dispatcher(
    mut command_rx: mpsc::Receiver<IncomingCommand>,
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut config = CommandConfigCache::new();

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

            config.refresh_if_needed(&db_conn).await;

            let response = dispatch_command(text, &config.prefix, &db_conn, &manager, config.lang).await;

            // Send response back via the same channel
            let send_result = manager.send_to_channel(cmd.channel_id, &response).await;
            let (status, error_detail) = match &send_result {
                Ok(_) => ("sent", None),
                Err(e) => {
                    eprintln!(
                        "[ChatChannel] failed to send response for {:?} to channel {}: {e}",
                        text, cmd.channel_id
                    );
                    ("failed", Some(e.to_string()))
                }
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
    prefix: &str,
    db: &DatabaseConnection,
    manager: &ChatChannelManager,
    lang: Lang,
) -> super::types::RichMessage {
    // Strip prefix; if text doesn't start with it, show help
    let without_prefix = match text.strip_prefix(prefix) {
        Some(rest) => rest,
        None => return command_handlers::handle_help(prefix, lang),
    };

    let parts: Vec<&str> = without_prefix.splitn(2, ' ').collect();
    let command = parts[0].to_lowercase();
    let args = parts.get(1).map(|s| s.trim()).unwrap_or("");

    match command.as_str() {
        "recent" => command_handlers::handle_recent(db, lang).await,
        "search" => {
            if args.is_empty() {
                super::types::RichMessage::info(i18n::search_usage(lang, prefix))
                    .with_title(i18n::invalid_args_title(lang))
            } else {
                command_handlers::handle_search(db, args, lang).await
            }
        }
        "detail" => {
            if let Ok(id) = args.parse::<i32>() {
                command_handlers::handle_detail(db, id, lang).await
            } else {
                super::types::RichMessage::info(i18n::detail_usage(lang, prefix))
                    .with_title(i18n::invalid_args_title(lang))
            }
        }
        "today" => command_handlers::handle_today(db, lang).await,
        "status" => command_handlers::handle_status(manager, lang).await,
        "help" | "start" => command_handlers::handle_help(prefix, lang),
        _ => super::types::RichMessage::info(i18n::unknown_command(lang, prefix, &command))
            .with_title(i18n::unknown_command_title(lang)),
    }
}
