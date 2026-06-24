use std::ffi::OsString;
use std::path::PathBuf;

use crate::models::{ConversationDetail, ConversationSummary};
use crate::parsers::{AgentParser, ParseError};

/// Resolve Kimi Code's data home, honoring `KIMI_CODE_HOME`, else `~/.kimi-code`
/// (mirrors `resolve_codebuddy_config_dir`). The transcript store lives under
/// the `sessions/` subdirectory of this path.
pub(crate) fn resolve_kimi_code_home_dir() -> PathBuf {
    resolve_kimi_code_home_from(std::env::var_os("KIMI_CODE_HOME"), dirs::home_dir())
}

fn resolve_kimi_code_home_from(
    kimi_code_home_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    kimi_code_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".kimi-code"))
}

/// Kimi Code (Moonshot AI) stores its session transcripts under a
/// **directory-per-session** layout — a third archetype distinct from CodeBuddy
/// (one JSONL file per session) and Hermes (a single SQLite DB):
///
/// ```text
/// $KIMI_CODE_HOME/                 (default ~/.kimi-code)
/// ├── config.toml
/// ├── session_index.jsonl          # JSONL index of all sessions
/// └── sessions/
///     └── <workDirKey>/            # bucketed by working directory
///         └── <sessionId>/
///             ├── state.json        # metadata: title, creation time
///             └── agents/
///                 ├── main/wire.jsonl       # the agent event stream
///                 └── <subagentId>/wire.jsonl
/// ```
///
/// `base_dir` points at the `sessions/` directory.
///
/// NOTE: This is a Phase 1 **skeleton**. The `wire.jsonl` / `state.json` JSON
/// schema is undocumented and will be reverse-engineered against a real captured
/// session in Phase 2; until then `list_conversations` returns nothing and
/// `get_conversation` reports `ConversationNotFound`. Keeping the wiring live
/// now (registry, `commands::conversations` dispatch, etc.) lets Phase 2 fill in
/// the body without touching any call sites.
pub struct KimiCodeParser {
    base_dir: PathBuf,
}

impl KimiCodeParser {
    pub fn new() -> Self {
        Self {
            base_dir: resolve_kimi_code_home_dir().join("sessions"),
        }
    }

    /// Construct a parser pointed at an explicit `sessions` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }
}

impl Default for KimiCodeParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for KimiCodeParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        // The transcript directory may not exist yet (Kimi never launched, or a
        // relocated KIMI_CODE_HOME). Phase 2 will walk
        // `base_dir/<workDirKey>/<sessionId>/` here, reading `state.json` and
        // counting `agents/main/wire.jsonl` content events.
        if !self.base_dir.is_dir() {
            return Ok(Vec::new());
        }
        Ok(Vec::new())
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        // Phase 2 will locate `base_dir/*/<conversation_id>/agents/main/wire.jsonl`
        // and map its event stream onto MessageTurns.
        Err(ParseError::ConversationNotFound(conversation_id.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_home_prefers_env_override() {
        let resolved = resolve_kimi_code_home_from(
            Some(OsString::from("/tmp/custom-kimi")),
            Some(PathBuf::from("/home/demo")),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/custom-kimi"));
    }

    #[test]
    fn resolve_home_ignores_empty_env_and_uses_home() {
        let resolved = resolve_kimi_code_home_from(
            Some(OsString::from("")),
            Some(PathBuf::from("/home/demo")),
        );
        assert_eq!(resolved, PathBuf::from("/home/demo/.kimi-code"));
    }

    #[test]
    fn resolve_home_defaults_to_home_when_env_unset() {
        let resolved = resolve_kimi_code_home_from(None, Some(PathBuf::from("/home/demo")));
        assert_eq!(resolved, PathBuf::from("/home/demo/.kimi-code"));
    }

    #[test]
    fn skeleton_lists_nothing_for_missing_dir() {
        let parser = KimiCodeParser::with_base_dir(PathBuf::from("/nonexistent/kimi/sessions"));
        assert!(parser
            .list_conversations()
            .expect("skeleton list is infallible")
            .is_empty());
    }
}
