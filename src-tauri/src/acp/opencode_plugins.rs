use std::path::PathBuf;

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
