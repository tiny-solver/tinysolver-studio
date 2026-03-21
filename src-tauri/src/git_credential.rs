use std::path::{Path, PathBuf};

use sea_orm::DatabaseConnection;

use crate::db::service::app_metadata_service;
use crate::models::system::{GitHubAccount, GitHubAccountsSettings};

const GITHUB_ACCOUNTS_KEY: &str = "github_accounts";

/// Ensure the GIT_ASKPASS helper script exists in the app data directory.
/// Returns the path to the script.
pub fn ensure_askpass_script(app_data_dir: &Path) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        let script_path = app_data_dir.join("git-askpass.sh");
        if !script_path.exists() {
            let content = r#"#!/bin/sh
case "$1" in
*[Uu]sername*) echo "$CODEG_GIT_USERNAME" ;;
*[Pp]assword*) echo "$CODEG_GIT_PASSWORD" ;;
esac
"#;
            std::fs::write(&script_path, content)?;
            // Make executable
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(script_path)
    }

    #[cfg(windows)]
    {
        let script_path = app_data_dir.join("git-askpass.bat");
        if !script_path.exists() {
            let content = r#"@echo off
echo %1 | findstr /i "username" >nul
if %errorlevel% equ 0 (
    echo %CODEG_GIT_USERNAME%
    exit /b
)
echo %1 | findstr /i "password" >nul
if %errorlevel% equ 0 (
    echo %CODEG_GIT_PASSWORD%
    exit /b
)
"#;
            std::fs::write(&script_path, content)?;
        }
        Ok(script_path)
    }
}

/// Inject GitHub credentials into a git command via GIT_ASKPASS.
pub fn inject_credentials(
    cmd: &mut tokio::process::Command,
    username: &str,
    token: &str,
    askpass_path: &Path,
) {
    cmd.env("GIT_ASKPASS", askpass_path)
        .env("CODEG_GIT_USERNAME", username)
        .env("CODEG_GIT_PASSWORD", token)
        .env("GIT_TERMINAL_PROMPT", "0");
}

/// Get the remote URL for the "origin" remote of a repository.
pub async fn get_remote_url(repo_path: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() { None } else { Some(url) }
}

/// Extract the hostname from a git remote URL.
///
/// Handles both HTTPS and SSH URLs:
/// - `https://github.com/user/repo.git` → `github.com`
/// - `git@github.com:user/repo.git` → `github.com`
fn extract_host(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();

    // HTTPS: https://github.com/...
    if let Some(after_scheme) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        // Strip optional user@ prefix (e.g. https://user@github.com/...)
        let after_at = after_scheme
            .find('@')
            .map(|i| &after_scheme[i + 1..])
            .unwrap_or(after_scheme);
        return after_at.split('/').next().map(|h| h.to_lowercase());
    }

    // SSH: git@github.com:user/repo.git
    if let Some(at_pos) = url.find('@') {
        let after_at = &url[at_pos + 1..];
        return after_at.split(':').next().map(|h| h.to_lowercase());
    }

    None
}

/// Find the best matching account for a given remote URL.
///
/// Only returns an account whose server_url hostname matches the remote URL host.
/// Does NOT fall back to unrelated accounts — if no hostname matches, returns None
/// so the caller can fall back to git config defaults.
pub fn find_matching_account<'a>(
    accounts: &'a [GitHubAccount],
    remote_url: &str,
) -> Option<&'a GitHubAccount> {
    if accounts.is_empty() {
        return None;
    }

    let remote_host = extract_host(remote_url)?;

    accounts.iter().find(|a| {
        let account_host = extract_host(&a.server_url)
            .unwrap_or_else(|| a.server_url.trim().trim_end_matches('/').to_lowercase());
        account_host == remote_host
    })
}

/// Load GitHub accounts from the database.
pub async fn load_github_accounts(
    conn: &DatabaseConnection,
) -> Option<GitHubAccountsSettings> {
    let raw = app_metadata_service::get_value(conn, GITHUB_ACCOUNTS_KEY)
        .await
        .ok()??;

    serde_json::from_str::<GitHubAccountsSettings>(&raw).ok()
}

/// Resolve the commit author (name + email) from the matching account for a repo.
///
/// Returns `Some((name, email))` if a matching account is found.
/// Uses GitHub's noreply email format: `username@users.noreply.github.com`.
pub async fn resolve_commit_author(
    repo_path: &str,
    conn: &DatabaseConnection,
) -> Option<(String, String)> {
    let settings = load_github_accounts(conn).await?;
    if settings.accounts.is_empty() {
        return None;
    }

    let remote_url = get_remote_url(repo_path).await?;
    let account = find_matching_account(&settings.accounts, &remote_url)?;

    let host = extract_host(&remote_url).unwrap_or_default();
    let email = if host == "github.com" {
        format!("{}@users.noreply.github.com", account.username)
    } else {
        // For non-GitHub hosts, use username@host as a reasonable fallback
        format!("{}@{}", account.username, host)
    };

    Some((account.username.clone(), email))
}

/// Resolve credentials for a git repository and inject them into the command.
///
/// This is the main entry point: given a repo path and a git command,
/// it finds the matching GitHub account and injects credentials.
/// Returns `true` if credentials were injected.
pub async fn try_inject_for_repo(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> bool {
    let settings = match load_github_accounts(conn).await {
        Some(s) if !s.accounts.is_empty() => s,
        _ => return false,
    };

    let remote_url = match get_remote_url(repo_path).await {
        Some(url) => url,
        None => return false,
    };

    // Only inject for HTTPS URLs (SSH uses keys, not tokens)
    if !remote_url.starts_with("https://") && !remote_url.starts_with("http://") {
        return false;
    }

    let account = match find_matching_account(&settings.accounts, &remote_url) {
        Some(a) => a,
        None => return false,
    };

    let askpass = match ensure_askpass_script(app_data_dir) {
        Ok(p) => p,
        Err(_) => return false,
    };

    inject_credentials(cmd, &account.username, &account.token, &askpass);
    true
}

/// Same as `try_inject_for_repo` but for clone operations where
/// we don't have a repo path yet — just a URL.
pub async fn try_inject_for_url(
    cmd: &mut tokio::process::Command,
    clone_url: &str,
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> bool {
    if !clone_url.starts_with("https://") && !clone_url.starts_with("http://") {
        return false;
    }

    let settings = match load_github_accounts(conn).await {
        Some(s) if !s.accounts.is_empty() => s,
        _ => return false,
    };

    let account = match find_matching_account(&settings.accounts, clone_url) {
        Some(a) => a,
        None => return false,
    };

    let askpass = match ensure_askpass_script(app_data_dir) {
        Ok(p) => p,
        Err(_) => return false,
    };

    inject_credentials(cmd, &account.username, &account.token, &askpass);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_host_https() {
        assert_eq!(
            extract_host("https://github.com/user/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_host("https://user@github.com/user/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_host("https://gitlab.example.com/org/repo"),
            Some("gitlab.example.com".to_string())
        );
    }

    #[test]
    fn test_extract_host_ssh() {
        assert_eq!(
            extract_host("git@github.com:user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn test_find_matching_account() {
        let accounts = vec![
            GitHubAccount {
                id: "1".into(),
                server_url: "https://github.com".into(),
                username: "user1".into(),
                token: "tok1".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: false,
                created_at: String::new(),
            },
            GitHubAccount {
                id: "2".into(),
                server_url: "https://gitlab.example.com".into(),
                username: "user2".into(),
                token: "tok2".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: true,
                created_at: String::new(),
            },
        ];

        let matched = find_matching_account(&accounts, "https://github.com/org/repo.git");
        assert_eq!(matched.unwrap().username, "user1");

        let matched = find_matching_account(&accounts, "https://gitlab.example.com/org/repo");
        assert_eq!(matched.unwrap().username, "user2");

        // Unknown host returns None — no fallback to unrelated accounts
        let matched = find_matching_account(&accounts, "https://unknown.com/repo");
        assert!(matched.is_none());
    }
}
