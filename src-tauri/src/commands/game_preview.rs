//! Change signal for the game preview pane's auto-reload.
//!
//! Serving the game itself is `crate::content_preview` (the project folder
//! over HTTP, addressed by a per-root id). This module only answers "did
//! anything under the game directory change?", which the pane polls so an
//! agent's write shows up in the iframe without a manual reload.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use crate::app_error::AppCommandError;
use crate::commands::folders::resolve_tree_path;

fn resolve_dir(root_path: &str, dir: &str) -> Result<PathBuf, AppCommandError> {
    let root = PathBuf::from(root_path.trim());
    if !root.is_dir() {
        return Err(AppCommandError::not_found("Folder does not exist"));
    }
    let target = resolve_tree_path(&root, dir.trim())?;
    let canonical_root = std::fs::canonicalize(&root).map_err(AppCommandError::io)?;
    let canonical = std::fs::canonicalize(&target).map_err(AppCommandError::io)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(AppCommandError::invalid_input("Path is outside workspace root"));
    }
    if !canonical.is_dir() {
        return Err(AppCommandError::invalid_input("Path is not a directory"));
    }
    Ok(canonical)
}

/// File count, newest mtime, and total size under `<root>/<dir>` (skipping
/// dot-dirs and `node_modules`), as one string that changes when the
/// directory does.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn game_preview_fingerprint(
    root_path: String,
    dir: String,
) -> Result<String, AppCommandError> {
    let canonical = resolve_dir(&root_path, &dir)?;
    tokio::task::spawn_blocking(move || {
        let mut count: u64 = 0;
        let mut newest: u128 = 0;
        let mut bytes: u64 = 0;
        let mut stack = vec![canonical];
        while let Some(current) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(entry.path());
                    continue;
                }
                count += 1;
                bytes += meta.len();
                if let Some(ms) = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                {
                    newest = newest.max(ms);
                }
            }
        }
        Ok(format!("{count}:{newest}:{bytes}"))
    })
    .await
    .map_err(|e| AppCommandError::io_error(format!("fingerprint task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn changes_when_files_change_and_stays_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let game = dir.path().join("outputs/game");
        fs::create_dir_all(game.join("src")).unwrap();
        fs::write(game.join("index.html"), "<!doctype html>").unwrap();
        let root = dir.path().to_string_lossy().to_string();

        let before = game_preview_fingerprint(root.clone(), "outputs/game".into())
            .await
            .unwrap();
        fs::write(game.join("src/extra.js"), "export const b = 2").unwrap();
        let after = game_preview_fingerprint(root.clone(), "outputs/game".into())
            .await
            .unwrap();
        assert_ne!(before, after);

        assert!(game_preview_fingerprint(root.clone(), "../".into()).await.is_err());
        assert!(game_preview_fingerprint(root.clone(), "missing".into()).await.is_err());
        assert!(game_preview_fingerprint(root, "/etc".into()).await.is_err());
    }
}
