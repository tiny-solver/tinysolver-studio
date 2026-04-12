use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginStatus {
    Installed,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub declared_spec: String,
    pub installed_version: Option<String>,
    pub status: PluginStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginCheckSummary {
    pub config_path: PathBuf,
    pub cache_dir: PathBuf,
    pub plugins: Vec<PluginInfo>,
    pub has_project_config_hint: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallEvent {
    pub task_id: String,
    pub kind: PluginInstallEventKind,
    pub payload: String,
}

/// Well-known paths for opencode configuration and cache.
fn opencode_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("opencode").join("opencode.json"))
}

fn opencode_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|d| d.join("opencode"))
}

/// Check whether a project directory contains any opencode configuration file.
fn has_project_opencode_config(project_root: &Path) -> bool {
    let candidates = [
        project_root.join("opencode.json"),
        project_root.join("opencode.jsonc"),
        project_root.join(".opencode").join("opencode.json"),
        project_root.join(".opencode").join("opencode.jsonc"),
    ];
    candidates.iter().any(|p| p.exists())
}

/// Inspect `~/.config/opencode/opencode.json` and `~/.cache/opencode/node_modules/`
/// to determine which declared plugins are installed and which are missing.
pub fn check_opencode_plugins(
    project_root: Option<&Path>,
) -> Result<PluginCheckSummary, String> {
    let config_path = opencode_config_path()
        .ok_or_else(|| "Cannot determine opencode config directory".to_string())?;
    let cache_dir = opencode_cache_dir()
        .ok_or_else(|| "Cannot determine opencode cache directory".to_string())?;

    let has_project_config_hint = project_root
        .map(|root| has_project_opencode_config(root))
        .unwrap_or(false);

    // If config file doesn't exist, there's nothing to check
    if !config_path.exists() {
        return Ok(PluginCheckSummary {
            config_path,
            cache_dir,
            plugins: vec![],
            has_project_config_hint,
        });
    }

    // Read and parse JSON
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", config_path.display()))?;

    // Extract plugin[] array
    let plugin_array = match doc.get("plugin") {
        Some(serde_json::Value::Array(arr)) => arr,
        Some(_) => {
            return Ok(PluginCheckSummary {
                config_path,
                cache_dir,
                plugins: vec![],
                has_project_config_hint,
            });
        }
        None => {
            return Ok(PluginCheckSummary {
                config_path,
                cache_dir,
                plugins: vec![],
                has_project_config_hint,
            });
        }
    };

    // Parse specs, dedup by name
    let mut seen_names = HashSet::new();
    let mut plugins = Vec::new();

    for item in plugin_array {
        let spec_str = match item.as_str() {
            Some(s) => s,
            None => {
                eprintln!("[opencode_plugins] Skipping non-string plugin entry: {item}");
                continue;
            }
        };

        let (name, declared_spec) = match parse_plugin_spec(spec_str) {
            Some(pair) => pair,
            None => {
                eprintln!("[opencode_plugins] Skipping invalid plugin spec: {spec_str:?}");
                continue;
            }
        };

        if !seen_names.insert(name.clone()) {
            continue; // duplicate, skip
        }

        // Check node_modules/<name>/package.json
        let pkg_json_path = cache_dir
            .join("node_modules")
            .join(&name)
            .join("package.json");

        let (status, installed_version) = if pkg_json_path.exists() {
            let version = std::fs::read_to_string(&pkg_json_path)
                .ok()
                .and_then(|content| {
                    serde_json::from_str::<serde_json::Value>(&content)
                        .ok()?
                        .get("version")?
                        .as_str()
                        .map(|s| s.to_string())
                });
            (PluginStatus::Installed, version)
        } else {
            (PluginStatus::Missing, None)
        };

        plugins.push(PluginInfo {
            name,
            declared_spec,
            installed_version,
            status,
        });
    }

    Ok(PluginCheckSummary {
        config_path,
        cache_dir,
        plugins,
        has_project_config_hint,
    })
}

/// Locate a usable bun binary.
/// Priority: opencode-bundled bun → system bun → error.
pub fn resolve_bun_binary() -> Result<PathBuf, String> {
    let cache_dir = opencode_cache_dir();

    // Try opencode-bundled bun
    if let Some(ref dir) = cache_dir {
        let candidates = if cfg!(windows) {
            vec![dir.join("bin").join("bun.exe")]
        } else {
            vec![dir.join("bin").join("bun")]
        };
        for candidate in candidates {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Fallback to system bun
    if let Ok(system_bun) = which::which("bun") {
        return Ok(system_bun);
    }

    Err(
        "bun binary not found. Neither opencode-bundled bun (~/.cache/opencode/bin/bun) \
         nor system bun is available."
            .to_string(),
    )
}

/// Detect whether a JSON string contains comments (// or /*).
fn json_has_comments(raw: &str) -> bool {
    raw.contains("//") || raw.contains("/*")
}

/// Write a timestamped backup of a file, keeping only the most recent `keep` copies.
fn write_backup_and_prune(path: &Path, content: &str, keep: usize) -> Result<(), String> {
    let now = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    let backup_path = path.with_file_name(format!(
        "{}.bak.{now}",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&backup_path, content)
        .map_err(|e| format!("Failed to write backup {}: {e}", backup_path.display()))?;

    // Prune old backups
    let parent = path.parent().ok_or("No parent directory")?;
    let stem = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let prefix = format!("{stem}.bak.");

    let mut backups: Vec<_> = fs::read_dir(parent)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&prefix)
        })
        .collect();

    // Sort by name descending (timestamp in name → newest first)
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

    for old in backups.iter().skip(keep) {
        let _ = fs::remove_file(old.path());
    }

    Ok(())
}

/// Atomically rewrite opencode.json: read → backup → mutate → write temp → rename.
pub(crate) fn atomic_rewrite_opencode_json(
    path: &Path,
    mutator: impl FnOnce(&mut serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    if json_has_comments(&raw) {
        return Err(
            "opencode.json contains comments (// or /*). Refusing to rewrite to avoid data loss. \
             Please edit the file manually."
                .to_string(),
        );
    }

    write_backup_and_prune(path, &raw, 3)?;

    let mut doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    mutator(&mut doc)?;

    let new_raw = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("Failed to serialize JSON: {e}"))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &new_raw)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename temp file: {e}"))?;

    Ok(())
}

/// Parse a plugin spec string from opencode.json `plugin[]` into (package_name, full_spec).
///
/// Examples:
/// - `"foo"` → `Some(("foo", "foo"))`
/// - `"foo@latest"` → `Some(("foo", "foo@latest"))`
/// - `"foo@1.2.3"` → `Some(("foo", "foo@1.2.3"))`
/// - `"@scope/name"` → `Some(("@scope/name", "@scope/name"))`
/// - `"@scope/name@1.2.3"` → `Some(("@scope/name", "@scope/name@1.2.3"))`
/// - `""` → `None`
pub fn parse_plugin_spec(spec: &str) -> Option<(String, String)> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }

    let full_spec = spec.to_string();

    if spec.starts_with('@') {
        // Scoped package: @scope/name or @scope/name@version
        let without_at = &spec[1..]; // strip leading @
        let slash_pos = without_at.find('/')?;
        let after_slash = &without_at[slash_pos + 1..];
        // Look for @ that separates name from version
        if let Some(version_at) = after_slash.find('@') {
            let name = &spec[..1 + slash_pos + 1 + version_at]; // @scope/name
            Some((name.to_string(), full_spec))
        } else {
            // No version part
            Some((spec.to_string(), full_spec))
        }
    } else {
        // Unscoped: name or name@version
        if let Some(at_pos) = spec.find('@') {
            let name = &spec[..at_pos];
            if name.is_empty() {
                return None; // bare "@" is invalid
            }
            Some((name.to_string(), full_spec))
        } else {
            Some((spec.to_string(), full_spec))
        }
    }
}
