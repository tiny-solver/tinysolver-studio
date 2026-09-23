//! Run Claude Code sessions on the machine's own `claude` CLI.
//!
//! The Claude adapter (`claude-agent-acp`) drives the Agent SDK, and the SDK
//! spawns a Claude Code binary. By default that binary is the one bundled in
//! the SDK package, so the CLI version — and with it the models a session can
//! pick — is frozen at whatever adapter the registry pins, until an upstream
//! release bumps it. The machine's native install (`~/.local/bin/claude`)
//! updates itself, so pointing the adapter at it keeps sessions on the newest
//! CLI without waiting for either.
//!
//! The adapter's only knob is `CLAUDE_CODE_EXECUTABLE`. The policy:
//! - the agent's env already names a path → the user chose, leave it
//! - it says `bundled` → drop it, the adapter falls back to the SDK's binary
//! - otherwise → the native install if there is one, else the first `claude`
//!   on `PATH`; nothing found leaves the bundled binary in charge
//!
//! Kept out of `acp/connection.rs` (upstream) so a sync only ever has to carry
//! the one call site.

use std::path::{Path, PathBuf};

use crate::models::agent::AgentType;

pub const EXECUTABLE_ENV: &str = "CLAUDE_CODE_EXECUTABLE";
/// Env value that opts a machine back into the SDK-bundled CLI.
pub const BUNDLED: &str = "bundled";

/// Apply the policy to a Claude Code launch env. Other agents pass through.
pub fn apply_claude_cli_policy(agent_type: AgentType, env: &mut Vec<(String, String)>) {
    if agent_type != AgentType::ClaudeCode {
        return;
    }
    let path_var = env
        .iter()
        .rev()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var("PATH").ok());
    let home = dirs::home_dir();
    apply_with(env, home.as_deref(), path_var.as_deref());
}

fn apply_with(env: &mut Vec<(String, String)>, home: Option<&Path>, path_var: Option<&str>) {
    let chosen = env
        .iter()
        .rev()
        .find(|(k, _)| k == EXECUTABLE_ENV)
        .map(|(_, v)| v.trim().to_string());
    match chosen.as_deref() {
        Some(v) if v.eq_ignore_ascii_case(BUNDLED) => {
            env.retain(|(k, _)| k != EXECUTABLE_ENV);
            tracing::info!("[studio] Claude Code: {EXECUTABLE_ENV}=bundled — using the SDK's CLI");
        }
        Some(v) if !v.is_empty() => {}
        _ => {
            env.retain(|(k, _)| k != EXECUTABLE_ENV);
            match find_system_claude(home, path_var) {
                Some(p) => {
                    tracing::info!("[studio] Claude Code: using system CLI {}", p.display());
                    env.push((EXECUTABLE_ENV.to_string(), p.to_string_lossy().into_owned()));
                }
                None => tracing::info!("[studio] Claude Code: no system CLI — using the SDK's"),
            }
        }
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

fn find_system_claude(home: Option<&Path>, path_var: Option<&str>) -> Option<PathBuf> {
    // The native installer's location first: a desktop launch never sees the
    // shell rc line that puts it on PATH.
    let native = home.map(|h| h.join(".local").join("bin").join(exe_name()));
    let on_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|d| d.join(exe_name()));
    native.into_iter().chain(on_path).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_exe(dir: &Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(exe_name());
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    fn get(env: &[(String, String)]) -> Option<&str> {
        env.iter()
            .find(|(k, _)| k == EXECUTABLE_ENV)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn prefers_native_install_over_path() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let native = make_exe(&home.path().join(".local/bin"));
        make_exe(bin.path());
        let mut env = vec![];
        apply_with(&mut env, Some(home.path()), bin.path().to_str());
        assert_eq!(get(&env), native.to_str());
    }

    #[test]
    fn falls_back_to_path() {
        let home = tempfile::tempdir().unwrap();
        let bin = tempfile::tempdir().unwrap();
        let on_path = make_exe(bin.path());
        let mut env = vec![];
        apply_with(&mut env, Some(home.path()), bin.path().to_str());
        assert_eq!(get(&env), on_path.to_str());
    }

    #[test]
    fn nothing_found_leaves_bundled() {
        let home = tempfile::tempdir().unwrap();
        let mut env = vec![];
        apply_with(&mut env, Some(home.path()), Some(""));
        assert_eq!(get(&env), None);
    }

    #[test]
    fn user_path_wins() {
        let home = tempfile::tempdir().unwrap();
        make_exe(&home.path().join(".local/bin"));
        let mut env = vec![(EXECUTABLE_ENV.to_string(), "/opt/claude".to_string())];
        apply_with(&mut env, Some(home.path()), None);
        assert_eq!(get(&env), Some("/opt/claude"));
    }

    #[test]
    fn bundled_opts_out() {
        let home = tempfile::tempdir().unwrap();
        make_exe(&home.path().join(".local/bin"));
        let mut env = vec![(EXECUTABLE_ENV.to_string(), "bundled".to_string())];
        apply_with(&mut env, Some(home.path()), None);
        assert_eq!(get(&env), None);
    }

    #[test]
    fn other_agents_untouched() {
        let mut env = vec![];
        apply_claude_cli_policy(AgentType::Codex, &mut env);
        assert!(env.is_empty());
    }
}
