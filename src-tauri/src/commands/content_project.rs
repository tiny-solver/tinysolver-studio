//! Content projects: one folder that holds a story bible (world, characters,
//! story) and every output made from it — a game, a webtoon, an instatoon, a
//! novel, video storyboards. The folder is a plain git-able directory with a
//! `codeg-project.json` manifest at its root, so every agent CLI the user runs
//! against it (Claude Code, Codex, Gemini CLI, ...) sees the same layout and
//! the same rules, written into the generated `AGENTS.md` / `CLAUDE.md`.
//!
//! This module only scaffolds and reads that folder. Studio documents,
//! asset validation, and per-output tooling all operate on the paths the
//! manifest declares; none of them are wired here yet.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::commands::project_boot::validate_project_name;

/// File at the project root that marks a folder as a content project.
pub const MANIFEST_FILE: &str = "codeg-project.json";

/// Current manifest schema. Bump when a field changes meaning; readers must
/// refuse newer schemas rather than guess.
pub const MANIFEST_SCHEMA: u32 = 1;

/// Every output form a project can target. Each one owns
/// `outputs/<kind>/` and a README describing its format rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputKind {
    Game,
    Webtoon,
    Instatoon,
    Novel,
    Video,
}

impl OutputKind {
    pub const ALL: [OutputKind; 5] = [
        OutputKind::Game,
        OutputKind::Webtoon,
        OutputKind::Instatoon,
        OutputKind::Novel,
        OutputKind::Video,
    ];

    pub fn dir_name(self) -> &'static str {
        match self {
            OutputKind::Game => "game",
            OutputKind::Webtoon => "webtoon",
            OutputKind::Instatoon => "instatoon",
            OutputKind::Novel => "novel",
            OutputKind::Video => "video",
        }
    }

    fn parse(raw: &str) -> Option<OutputKind> {
        OutputKind::ALL
            .into_iter()
            .find(|kind| kind.dir_name() == raw.trim())
    }
}

/// Runtime the `game` output is built on. Absent for projects with no game
/// output or with a game that has not picked an engine yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineInfo {
    /// Stable engine id (`three-web`, ...). Tools branch on this.
    pub id: String,
    /// Version of the scaffolded engine files, independent of the manifest schema.
    pub version: String,
    /// Relative path of the file to open for a preview.
    pub entry: String,
    /// Shell command that serves the game for development, run from the project root.
    pub start: String,
    /// Optional shell command run from the project root before packaging a
    /// build (a bundler, an asset pipeline). `None` for engines that run
    /// straight from source, such as `three-web`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

/// Where each layer lives, relative to the project root. Declared rather than
/// hardcoded so a project can move a layer without breaking tooling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectPaths {
    pub bible: String,
    pub assets: String,
    pub outputs: String,
    pub build: String,
}

impl Default for ProjectPaths {
    fn default() -> Self {
        Self {
            bible: "bible".into(),
            assets: "assets".into(),
            outputs: "outputs".into(),
            build: "build".into(),
        }
    }
}

/// The `codeg-project.json` document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentProjectManifest {
    pub schema: u32,
    pub name: String,
    pub created_at: String,
    /// Template id this project was created from.
    pub template: String,
    pub outputs: Vec<OutputKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineInfo>,
    #[serde(default)]
    pub paths: ProjectPaths,
    /// Which agent the user prefers per role (`writing`, `art`, `code`,
    /// `video`). Advisory: `null` means "whatever is selected". Kept in the
    /// manifest so the choice travels with the project, not the machine.
    #[serde(default)]
    pub agents: BTreeMap<String, Option<String>>,
    /// How to deploy a build to an outside host. Absent on a new project:
    /// the Studio's own `/play/<slug>/` link needs no configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish: Option<PublishConfig>,
}

/// `publish` in the manifest: one shell command, run from the project root,
/// that uploads a build directory somewhere and prints the resulting URL.
/// `{dir}` `{zip}` `{version}` `{name}` are substituted, and the same values
/// are exported as `CODEG_BUILD_DIR` `CODEG_BUILD_ZIP` `CODEG_BUILD_VERSION`
/// `CODEG_PROJECT_NAME` (prefer those in scripts: no quoting surprises).
/// Credentials stay with the CLI being called (wrangler, netlify, butler…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishConfig {
    pub command: String,
}

/// A project template the launcher can offer.
#[derive(Debug, Clone, Serialize)]
pub struct ContentTemplate {
    pub id: String,
    /// i18n key suffix under `ProjectBoot.content.templates`.
    pub label_key: String,
    pub default_outputs: Vec<OutputKind>,
    pub engine: Option<EngineInfo>,
}

/// Version of the managed `three-web` runtime a new project is created
/// against. The runtime itself is not scaffolded — see
/// [`crate::content_engine`]: the preview serves it and a build embeds it. A
/// project made with 0.2.x carries its own `src/main.js` runner and keeps
/// working; it just does not get engine upgrades.
pub const THREE_WEB_ENGINE_VERSION: &str = crate::content_engine::THREE_WEB_VERSION;

fn three_web_engine() -> EngineInfo {
    EngineInfo {
        id: "three-web".into(),
        version: THREE_WEB_ENGINE_VERSION.into(),
        entry: "outputs/game/index.html".into(),
        // The runtime lives in Tinysolver Studio, not in the project, so the way to
        // run the game outside the Studio is a build.
        start: "Tinysolver Studio preview, or serve a build: npx serve build/game/<version>".into(),
        build: None,
    }
}

/// Built-in templates. The `story` template has no engine so a project can
/// start from writing alone; `web-three` adds a Three.js game that runs from
/// a static file server with no build step.
pub fn builtin_templates() -> Vec<ContentTemplate> {
    vec![
        ContentTemplate {
            id: "story".into(),
            label_key: "story".into(),
            default_outputs: vec![OutputKind::Webtoon, OutputKind::Novel],
            engine: None,
        },
        ContentTemplate {
            id: "web-three".into(),
            label_key: "webThree".into(),
            default_outputs: vec![OutputKind::Game, OutputKind::Video],
            engine: Some(three_web_engine()),
        },
    ]
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_content_templates() -> Vec<ContentTemplate> {
    builtin_templates()
}

/// Create `<target_dir>/<project_name>` from a template with the chosen
/// outputs, write the manifest and rule files, and `git init` it (best
/// effort). Returns the new project path.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_content_project(
    project_name: String,
    target_dir: String,
    template: String,
    outputs: Vec<String>,
) -> Result<String, AppCommandError> {
    let project_name = project_name.trim().to_string();
    let target_dir = target_dir.trim().to_string();
    validate_project_name(&project_name)?;
    if target_dir.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Target directory is required",
        ));
    }
    let template = builtin_templates()
        .into_iter()
        .find(|t| t.id == template.trim())
        .ok_or_else(|| AppCommandError::invalid_input("Unknown template"))?;

    let mut kinds: Vec<OutputKind> = Vec::new();
    for raw in &outputs {
        let kind = OutputKind::parse(raw)
            .ok_or_else(|| AppCommandError::invalid_input(format!("Unknown output: {raw}")))?;
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Pick at least one output",
        ));
    }
    kinds.sort();

    let root = PathBuf::from(&target_dir).join(&project_name);
    if root.exists() {
        let is_empty = root
            .read_dir()
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return Err(AppCommandError::already_exists(
                "Target directory already exists and is not empty",
            ));
        }
    }

    // The engine only applies when a game output was actually chosen.
    let engine = if kinds.contains(&OutputKind::Game) {
        template.engine.clone()
    } else {
        None
    };
    let manifest = ContentProjectManifest {
        schema: MANIFEST_SCHEMA,
        name: project_name.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        template: template.id.clone(),
        outputs: kinds.clone(),
        engine,
        paths: ProjectPaths::default(),
        agents: ["writing", "art", "code", "video"]
            .into_iter()
            .map(|role| (role.to_string(), None))
            .collect(),
        publish: None,
    };

    let root_for_task = root.clone();
    let manifest_for_task = manifest.clone();
    tokio::task::spawn_blocking(move || scaffold(&root_for_task, &manifest_for_task))
        .await
        .map_err(|e| AppCommandError::io_error(format!("Scaffold task failed: {e}")))??;

    git_init(&root).await;

    Ok(root.to_string_lossy().to_string())
}

/// Read the manifest at `<path>/codeg-project.json`. `None` when the folder
/// is not a content project; an error only when the file exists but is
/// unreadable or from a newer schema.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_content_project(
    path: String,
) -> Result<Option<ContentProjectManifest>, AppCommandError> {
    let manifest_path = PathBuf::from(path.trim()).join(MANIFEST_FILE);
    let raw = match tokio::fs::read_to_string(&manifest_path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppCommandError::io(e)),
    };
    let manifest: ContentProjectManifest = serde_json::from_str(&raw)
        .map_err(|e| AppCommandError::invalid_input(format!("{MANIFEST_FILE}: {e}")))?;
    if manifest.schema > MANIFEST_SCHEMA {
        return Err(AppCommandError::invalid_input(format!(
            "{MANIFEST_FILE} uses schema {} but this app supports up to {MANIFEST_SCHEMA}",
            manifest.schema
        )));
    }
    Ok(Some(manifest))
}

// ---------------------------------------------------------------------------
// Scenes and builds
// ---------------------------------------------------------------------------

/// One `<scene>.studio.json` under the game's content directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContentScene {
    /// File stem, which the engine selects with `?scene=<id>`.
    pub id: String,
    /// `name` from the file, or the id when absent or unreadable.
    pub name: String,
    /// Project-relative path of the file.
    pub path: String,
}

pub(crate) fn game_content_dir(manifest: Option<&ContentProjectManifest>) -> String {
    let outputs = manifest
        .map(|m| m.paths.outputs.as_str())
        .unwrap_or("outputs");
    format!("{outputs}/game/content")
}

/// List the scenes of a project's game output, sorted by id. A folder that
/// is not a content project is still listed under the default layout so the
/// Studio can open a bare `outputs/game/content/`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_content_scenes(root: String) -> Result<Vec<ContentScene>, AppCommandError> {
    let root_path = PathBuf::from(root.trim());
    let manifest = read_content_project(root.clone()).await?;
    let content_dir = game_content_dir(manifest.as_ref());
    let dir = root_path.join(&content_dir);
    tokio::task::spawn_blocking(move || {
        let mut scenes = Vec::new();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(scenes),
            Err(e) => return Err(AppCommandError::io(e)),
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".studio.json") else {
                continue;
            };
            if id.is_empty() || !entry.path().is_file() {
                continue;
            }
            let display = fs::read_to_string(entry.path())
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| id.to_string());
            scenes.push(ContentScene {
                id: id.to_string(),
                name: display,
                path: format!("{content_dir}/{name}"),
            });
        }
        scenes.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(scenes)
    })
    .await
    .map_err(|e| AppCommandError::io_error(format!("Scene listing failed: {e}")))?
}

/// A packaged build under `<build>/game/<version>/`, described by its
/// `build-info.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentBuild {
    /// `v<N>-<yyyymmdd-HHMM>`; also the directory name.
    pub version: String,
    pub built_at: String,
    pub engine: String,
    pub engine_version: String,
    /// Path of the entry html inside the build directory.
    pub entry: String,
    /// Absolute build directory.
    pub dir: String,
    /// Absolute path of the zip next to the directory, when it was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zip: Option<String>,
    /// Total bytes copied into the build directory.
    pub size_bytes: u64,
    /// Captured stdout/stderr of `engine.build`, empty when there was none.
    #[serde(default)]
    pub log: String,
    /// Platform the build was made for — which `codeg-platform` adapter it
    /// carries. Builds from before the platform layer read as `web`.
    #[serde(default = "default_build_target")]
    pub target: String,
    /// "Runs anywhere" findings ([`crate::content_compat`]). Warnings on a
    /// `web` build.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Where this build has been released, at most one record per target.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub published: Vec<PublishRecord>,
}

fn default_build_target() -> String {
    crate::content_engine::BUILD_TARGETS[0].to_string()
}

/// One release of a build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishRecord {
    /// `local` — the Studio's `/play/<slug>/`; `command` — `publish.command`.
    pub target: String,
    /// `local`: a path on the Studio's origin (`/play/<slug>/`).
    /// `command`: the last http(s) URL the command printed, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub at: String,
    /// Output of the deploy command.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub log: String,
}

const BUILD_INFO_FILE: &str = "build-info.json";

fn builds_dir(root: &Path, manifest: &ContentProjectManifest) -> PathBuf {
    root.join(&manifest.paths.build).join("game")
}

fn read_builds(dir: &Path) -> Vec<ContentBuild> {
    let mut builds = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return builds;
    };
    for entry in entries.flatten() {
        let info = entry.path().join(BUILD_INFO_FILE);
        let Ok(raw) = fs::read_to_string(&info) else {
            continue;
        };
        if let Ok(mut build) = serde_json::from_str::<ContentBuild>(&raw) {
            // The directory may have been moved; trust where we found it.
            build.dir = entry.path().to_string_lossy().to_string();
            build.zip = build.zip.filter(|z| Path::new(z).is_file());
            builds.push(build);
        }
    }
    // Newest first: versions embed a timestamp, but the counter is what
    // orders two builds in the same minute.
    builds.sort_by(|a, b| b.built_at.cmp(&a.built_at).then(b.version.cmp(&a.version)));
    builds
}

/// Builds of the game output, newest first.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_content_builds(root: String) -> Result<Vec<ContentBuild>, AppCommandError> {
    let root_path = PathBuf::from(root.trim());
    let Some(manifest) = read_content_project(root).await? else {
        return Ok(Vec::new());
    };
    let dir = builds_dir(&root_path, &manifest);
    tokio::task::spawn_blocking(move || read_builds(&dir))
        .await
        .map_err(|e| AppCommandError::io_error(format!("Build listing failed: {e}")))
}

/// Package the game output as a deployable static folder plus a zip:
/// `<build>/game/<version>/` mirrors the project layout with only
/// `<outputs>/game/` and `<assets>/` copied, so the engine's relative asset
/// paths keep working unchanged. `engine.build`, when set, runs first from
/// the project root and must exit 0. Nothing under the source layers is
/// written; a failed build leaves no partial directory behind.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn build_content_project(root: String) -> Result<ContentBuild, AppCommandError> {
    let root_path = PathBuf::from(root.trim());
    let manifest = read_content_project(root.clone())
        .await?
        .ok_or_else(|| AppCommandError::not_found("This folder is not a content project"))?;
    let engine = manifest
        .engine
        .clone()
        .ok_or_else(|| AppCommandError::invalid_input("The project has no game engine to build"))?;
    if !manifest.outputs.contains(&OutputKind::Game) {
        return Err(AppCommandError::invalid_input(
            "The project has no game output",
        ));
    }

    let mut log = String::new();
    if let Some(command) = engine.build.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        let output = shell_command(command, &root_path)
            .output()
            .await
            .map_err(|e| AppCommandError::external_command("engine.build failed to start", e.to_string()))?;
        log.push_str(&String::from_utf8_lossy(&output.stdout));
        log.push_str(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            return Err(AppCommandError::external_command(
                format!("engine.build exited with {}", output.status),
                log,
            ));
        }
    }

    tokio::task::spawn_blocking(move || package_build(&root_path, &manifest, &engine, log))
        .await
        .map_err(|e| AppCommandError::io_error(format!("Build task failed: {e}")))?
}

/// Release a build. `version` defaults to the newest build.
///
/// - `local`: the Studio serves the build at `/play/<slug>/` (see
///   [`crate::content_publish`]). The link is stable across versions.
/// - `command`: runs the manifest's `publish.command` from the project root
///   and records the last URL it printed.
///
/// The outcome is written into the build's `build-info.json` so the list of
/// builds shows where each one went.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn publish_content_build(
    root: String,
    version: Option<String>,
    target: String,
) -> Result<ContentBuild, AppCommandError> {
    publish_content_build_in(&crate::content_publish::registry_path(), root, version, target).await
}

pub(crate) async fn publish_content_build_in(
    registry: &Path,
    root: String,
    version: Option<String>,
    target: String,
) -> Result<ContentBuild, AppCommandError> {
    let root_path = PathBuf::from(root.trim());
    let manifest = read_content_project(root.clone())
        .await?
        .ok_or_else(|| AppCommandError::not_found("This folder is not a content project"))?;
    let builds = read_builds(&builds_dir(&root_path, &manifest));
    let wanted = version.as_deref().map(str::trim).filter(|v| !v.is_empty());
    let mut build = match wanted {
        Some(v) => builds
            .into_iter()
            .find(|b| b.version == v)
            .ok_or_else(|| AppCommandError::not_found(format!("No build named {v}")))?,
        None => builds
            .into_iter()
            .next()
            .ok_or_else(|| AppCommandError::not_found("No build yet. Build the game first."))?,
    };
    let at = chrono::Local::now().to_rfc3339();

    let record = match target.trim() {
        "local" => {
            // Canonical root: the desktop and the server may spell it differently.
            let key = root_path
                .canonicalize()
                .unwrap_or_else(|_| root_path.clone())
                .to_string_lossy()
                .to_string();
            let game = crate::content_publish::publish_in(
                registry,
                &key,
                &manifest.name,
                &build.version,
                &build.dir,
            )
            .map_err(AppCommandError::io)?;
            // One project, one link: the other builds no longer hold it.
            clear_published(&root_path, &manifest, "local", Some(&build.version));
            PublishRecord {
                target: "local".into(),
                url: Some(crate::content_publish::play_path(&game.slug)),
                at,
                log: String::new(),
            }
        }
        "command" => {
            let template = manifest
                .publish
                .as_ref()
                .map(|p| p.command.trim())
                .filter(|c| !c.is_empty())
                .ok_or_else(|| {
                    AppCommandError::invalid_input(
                        "codeg-project.json has no publish.command. Add one, e.g. \"publish\": { \"command\": \"npx wrangler pages deploy $CODEG_BUILD_DIR --project-name my-game\" }",
                    )
                })?;
            let zip = build.zip.clone().unwrap_or_default();
            let line = template
                .replace("{dir}", &build.dir)
                .replace("{zip}", &zip)
                .replace("{version}", &build.version)
                .replace("{name}", &manifest.name);
            let output = shell_command(&line, &root_path)
                .env("CODEG_BUILD_DIR", &build.dir)
                .env("CODEG_BUILD_ZIP", &zip)
                .env("CODEG_BUILD_VERSION", &build.version)
                .env("CODEG_PROJECT_NAME", &manifest.name)
                .output()
                .await
                .map_err(|e| {
                    AppCommandError::external_command("publish.command failed to start", e.to_string())
                })?;
            let mut log = String::from_utf8_lossy(&output.stdout).to_string();
            log.push_str(&String::from_utf8_lossy(&output.stderr));
            if !output.status.success() {
                return Err(AppCommandError::external_command(
                    format!("publish.command exited with {}", output.status),
                    log,
                ));
            }
            PublishRecord {
                target: "command".into(),
                url: last_url(&log),
                at,
                log,
            }
        }
        other => {
            return Err(AppCommandError::invalid_input(format!(
                "Unknown publish target {other:?}; expected \"local\" or \"command\""
            )))
        }
    };

    build.published.retain(|r| r.target != record.target);
    build.published.push(record);
    write_build_info(&build)?;
    Ok(build)
}

/// Take the project's `/play/<slug>/` link down.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn unpublish_content_game(root: String) -> Result<bool, AppCommandError> {
    unpublish_content_game_in(&crate::content_publish::registry_path(), root).await
}

pub(crate) async fn unpublish_content_game_in(
    registry: &Path,
    root: String,
) -> Result<bool, AppCommandError> {
    let root_path = PathBuf::from(root.trim());
    let key = root_path
        .canonicalize()
        .unwrap_or_else(|_| root_path.clone())
        .to_string_lossy()
        .to_string();
    let removed = crate::content_publish::unpublish_in(registry, &key).map_err(AppCommandError::io)?;
    if let Some(manifest) = read_content_project(root).await? {
        clear_published(&root_path, &manifest, "local", None);
    }
    Ok(removed)
}

/// Drop `target` records from every build except `keep`.
fn clear_published(root: &Path, manifest: &ContentProjectManifest, target: &str, keep: Option<&str>) {
    for mut build in read_builds(&builds_dir(root, manifest)) {
        if Some(build.version.as_str()) == keep {
            continue;
        }
        let before = build.published.len();
        build.published.retain(|r| r.target != target);
        if build.published.len() != before {
            let _ = write_build_info(&build);
        }
    }
}

fn write_build_info(build: &ContentBuild) -> Result<(), AppCommandError> {
    fs::write(
        Path::new(&build.dir).join(BUILD_INFO_FILE),
        serde_json::to_string_pretty(build).map_err(|e| AppCommandError::io_error(e.to_string()))?,
    )
    .map_err(AppCommandError::io)
}

/// The last http(s) URL in a deploy tool's output — CLIs print progress
/// links first and the final address last.
fn last_url(log: &str) -> Option<String> {
    log.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '(' | ')'))
        .filter(|w| w.starts_with("https://") || w.starts_with("http://"))
        .map(|w| w.trim_end_matches(['.', ',', ';', ':']).to_string())
        .rfind(|w| w.len() > "https://".len())
}

fn shell_command(line: &str, cwd: &Path) -> tokio::process::Command {
    #[cfg(not(windows))]
    let mut command = {
        let mut c = crate::process::tokio_command("/bin/sh");
        c.arg("-lc").arg(line);
        c
    };
    #[cfg(windows)]
    let mut command = {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = crate::process::tokio_command(comspec);
        c.arg("/C").arg(line);
        c
    };
    command.current_dir(cwd);
    command.stdin(std::process::Stdio::null());
    command
}

fn package_build(
    root: &Path,
    manifest: &ContentProjectManifest,
    engine: &EngineInfo,
    log: String,
) -> Result<ContentBuild, AppCommandError> {
    let dir = builds_dir(root, manifest);
    fs::create_dir_all(&dir).map_err(AppCommandError::io)?;
    let count = read_builds(&dir).len();
    let now = chrono::Local::now();
    let version = format!("v{}-{}", count + 1, now.format("%Y%m%d-%H%M"));
    let target = dir.join(&version);
    if target.exists() {
        return Err(AppCommandError::already_exists(format!(
            "Build {version} already exists"
        )));
    }
    let staging = dir.join(format!(".{version}.partial"));
    let _ = fs::remove_dir_all(&staging);
    let target_name = default_build_target();
    let platform_files = crate::content_engine::build_files(&target_name)
        .ok_or_else(|| AppCommandError::invalid_input(format!("Unknown build target {target_name}")))?;

    let result = (|| {
        let mut size = 0u64;
        let game_src = root.join(&manifest.paths.outputs).join("game");
        if !game_src.is_dir() {
            return Err(AppCommandError::not_found("outputs/game does not exist"));
        }
        size += copy_tree(&game_src, &staging.join(&manifest.paths.outputs).join("game"))?;
        let assets_src = root.join(&manifest.paths.assets);
        if assets_src.is_dir() {
            size += copy_tree(&assets_src, &staging.join(&manifest.paths.assets))?;
        }
        // A top-level index.html so the folder (or zip) opens straight into
        // the game from any static host.
        let entry = engine.entry.trim_start_matches("./").to_string();
        // The managed runtime, the vendored Three.js and the target's
        // platform adapter are not in the project; the entry page
        // import-maps them to `../../__codeg/…`. Write them at that path so
        // the build runs with no Studio and no CDN. A page from before the
        // platform layer gets its import-map entry here, as in the preview.
        let entry_html = fs::read_to_string(root.join(&entry)).unwrap_or_default();
        if crate::content_engine::page_uses_managed_engine(&entry_html) {
            if let Some(html) = crate::content_engine::with_platform_import(&entry_html) {
                let staged_entry = staging.join(&entry);
                if staged_entry.is_file() {
                    fs::write(&staged_entry, html).map_err(AppCommandError::io)?;
                }
            }
            for file in platform_files {
                let dest = staging.join(file.path);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(AppCommandError::io)?;
                }
                fs::write(&dest, file.bytes).map_err(AppCommandError::io)?;
                size += file.bytes.len() as u64;
            }
        }
        fs::write(
            staging.join("index.html"),
            format!(
                "<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"0; url={entry}\"><title>{}</title><a href=\"{entry}\">{entry}</a>\n",
                manifest.name
            ),
        )
        .map_err(AppCommandError::io)?;
        let warnings = crate::content_compat::check_build(&staging, size);
        let mut log = log.clone();
        if !warnings.is_empty() {
            log.push_str(&format!(
                "{}compat: {} warning(s) — see ENGINE.md \"어디서든 돌려면\"\n",
                if log.is_empty() || log.ends_with('\n') { "" } else { "\n" },
                warnings.len()
            ));
            for w in &warnings {
                log.push_str(&format!("  {w}\n"));
            }
        }
        let info = ContentBuild {
            version: version.clone(),
            built_at: now.to_rfc3339(),
            engine: engine.id.clone(),
            engine_version: engine.version.clone(),
            entry,
            dir: target.to_string_lossy().to_string(),
            zip: None,
            size_bytes: size,
            log,
            target: target_name.clone(),
            warnings,
            published: Vec::new(),
        };
        fs::write(
            staging.join(BUILD_INFO_FILE),
            serde_json::to_string_pretty(&info).map_err(|e| AppCommandError::io_error(e.to_string()))?,
        )
        .map_err(AppCommandError::io)?;
        fs::rename(&staging, &target).map_err(AppCommandError::io)?;

        let zip_path = dir.join(format!("{version}.zip"));
        let zip = match zip_tree(&target, &zip_path, &version) {
            Ok(()) => Some(zip_path.to_string_lossy().to_string()),
            Err(e) => {
                tracing::warn!("[ContentProject] zip failed for {version}: {e}");
                let _ = fs::remove_file(&zip_path);
                None
            }
        };
        let info = ContentBuild { zip, ..info };
        fs::write(
            target.join(BUILD_INFO_FILE),
            serde_json::to_string_pretty(&info).map_err(|e| AppCommandError::io_error(e.to_string()))?,
        )
        .map_err(AppCommandError::io)?;
        Ok(info)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// Recursive copy for a build: skips dot-files, `node_modules`, symlinks and
/// Markdown (GDD · README · ENGINE.md — authoring docs, not something the
/// game runs; the GDD is not meant to be public either). Returns the bytes
/// copied.
fn copy_tree(from: &Path, to: &Path) -> Result<u64, AppCommandError> {
    let mut total = 0u64;
    fs::create_dir_all(to).map_err(AppCommandError::io)?;
    for entry in fs::read_dir(from).map_err(AppCommandError::io)? {
        let entry = entry.map_err(AppCommandError::io)?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" {
            continue;
        }
        let file_type = entry.file_type().map_err(AppCommandError::io)?;
        if file_type.is_file() && name_str.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        if file_type.is_symlink() {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if file_type.is_dir() {
            total += copy_tree(&src, &dst)?;
        } else {
            total += fs::copy(&src, &dst).map_err(AppCommandError::io)?;
        }
    }
    Ok(total)
}

fn zip_tree(dir: &Path, zip_path: &Path, prefix: &str) -> Result<(), String> {
    use std::io::Write;
    let file = fs::File::create(zip_path).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        let rel = entry.path().strip_prefix(dir).map_err(|e| e.to_string())?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let name = format!(
            "{prefix}/{}",
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        );
        if entry.file_type().is_dir() {
            writer.add_directory(name, options).map_err(|e| e.to_string())?;
        } else {
            writer.start_file(name, options).map_err(|e| e.to_string())?;
            let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
            writer.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Register the project folder for iframe preview and return its URL parts.
/// Desktop gets a loopback origin because the embedded web service may be
/// off; the server binary's HTTP handler is reached on the API origin.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_content_preview(
    root: String,
) -> Result<crate::content_preview::ContentPreviewInfo, AppCommandError> {
    crate::content_preview::describe(&root, cfg!(feature = "tauri-runtime")).await
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

fn write(root: &Path, rel: &str, contents: &str) -> Result<(), AppCommandError> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(AppCommandError::io)?;
    }
    fs::write(&path, contents).map_err(AppCommandError::io)
}

fn scaffold(root: &Path, manifest: &ContentProjectManifest) -> Result<(), AppCommandError> {
    fs::create_dir_all(root).map_err(AppCommandError::io)?;

    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|e| AppCommandError::io_error(e.to_string()))?;
    write(root, MANIFEST_FILE, &format!("{manifest_json}\n"))?;

    let rules = agent_rules(manifest);
    write(root, "AGENTS.md", &rules)?;
    write(root, "CLAUDE.md", &rules)?;
    write(root, "README.md", &project_readme(manifest))?;
    write(root, ".gitignore", GITIGNORE)?;

    let bible = &manifest.paths.bible;
    write(root, &format!("{bible}/README.md"), BIBLE_README)?;
    write(root, &format!("{bible}/world.md"), WORLD_MD)?;
    write(root, &format!("{bible}/characters/README.md"), CHARACTERS_README)?;
    write(root, &format!("{bible}/characters/_template.md"), CHARACTER_TEMPLATE)?;
    write(root, &format!("{bible}/story/README.md"), STORY_README)?;
    write(root, &format!("{bible}/story/synopsis.md"), SYNOPSIS_MD)?;

    let assets = &manifest.paths.assets;
    write(root, &format!("{assets}/README.md"), ASSETS_README)?;
    write(root, &format!("{assets}/manifest.json"), ASSETS_MANIFEST)?;
    write(root, &format!("{assets}/characters/.gitkeep"), "")?;
    write(root, &format!("{assets}/backgrounds/.gitkeep"), "")?;
    write(root, &format!("{assets}/ui/.gitkeep"), "")?;

    write(root, &format!("{}/.gitkeep", manifest.paths.build), "")?;

    let outputs = &manifest.paths.outputs;
    for kind in &manifest.outputs {
        let dir = format!("{outputs}/{}", kind.dir_name());
        match kind {
            OutputKind::Game => {
                write(root, &format!("{dir}/README.md"), GAME_README)?;
                write(root, &format!("{dir}/GDD.md"), GDD_MD)?;
                write(root, &format!("{dir}/content/README.md"), GAME_CONTENT_README)?;
                write(root, &format!("{dir}/content/main.studio.json"), STARTER_SCENE)?;
                if let Some(engine) = &manifest.engine {
                    if engine.id == "three-web" {
                        write(root, &format!("{dir}/index.html"), THREE_INDEX_HTML)?;
                        write(root, &format!("{dir}/src/main.js"), GAME_MAIN_JS)?;
                        write(root, &format!("{dir}/src/scripts/index.js"), GAME_SCRIPTS_JS)?;
                        write(root, &format!("{dir}/ENGINE.md"), crate::content_engine::engine_doc())?;
                    }
                }
            }
            OutputKind::Webtoon => {
                write(root, &format!("{dir}/README.md"), WEBTOON_README)?;
                write(root, &format!("{dir}/episodes/.gitkeep"), "")?;
            }
            OutputKind::Instatoon => {
                write(root, &format!("{dir}/README.md"), INSTATOON_README)?;
                write(root, &format!("{dir}/posts/.gitkeep"), "")?;
            }
            OutputKind::Novel => {
                write(root, &format!("{dir}/README.md"), NOVEL_README)?;
                write(root, &format!("{dir}/chapters/.gitkeep"), "")?;
            }
            OutputKind::Video => {
                write(root, &format!("{dir}/README.md"), VIDEO_README)?;
                write(root, &format!("{dir}/storyboards/.gitkeep"), "")?;
                write(root, &format!("{dir}/storyboards/_template.md"), STORYBOARD_TEMPLATE)?;
            }
        }
    }
    Ok(())
}

/// `git init` so the source, bible, and assets are versioned from the first
/// commit. Best effort: a missing git binary leaves a perfectly usable folder.
async fn git_init(root: &Path) {
    let mut cmd = crate::process::tokio_command("git");
    cmd.arg("init").arg("-q").current_dir(root);
    match cmd.output().await {
        Ok(output) if output.status.success() => {}
        Ok(output) => tracing::warn!(
            "[ContentProject] git init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(e) => tracing::warn!("[ContentProject] git init skipped: {e}"),
    }
}

fn outputs_list(manifest: &ContentProjectManifest) -> String {
    manifest
        .outputs
        .iter()
        .map(|kind| format!("`{}/{}/`", manifest.paths.outputs, kind.dir_name()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn project_readme(manifest: &ContentProjectManifest) -> String {
    let mut out = format!(
        "# {name}\n\nTinysolver Studio 콘텐츠 프로젝트. 세계관·캐릭터·스토리(`{bible}/`)를 한 곳에 두고, 그로부터 여러 형태의 결과물을 만든다.\n\n결과물: {outputs}\n\n",
        name = manifest.name,
        bible = manifest.paths.bible,
        outputs = outputs_list(manifest),
    );
    if let Some(engine) = &manifest.engine {
        out.push_str(&format!(
            "게임 엔진: `{}` v{}\n\n미리보기:\n\n```sh\n{}\n```\n\n",
            engine.id, engine.version, engine.start
        ));
    }
    out.push_str("폴더 규칙은 `AGENTS.md`에 있다. 에이전트와 사람 모두 그 규칙을 따른다.\n");
    out
}

fn agent_rules(manifest: &ContentProjectManifest) -> String {
    let p = &manifest.paths;
    let mut out = String::new();
    out.push_str("# AGENTS.md — 콘텐츠 프로젝트 규칙\n\n");
    out.push_str("이 폴더는 Tinysolver Studio 콘텐츠 프로젝트다. 루트의 `codeg-project.json`이 정본이며, 이 문서는 그 규칙을 사람과 에이전트가 읽는 형태로 적은 것이다. 어떤 에이전트 CLI로 작업하든 같은 규칙을 따른다.\n\n");

    out.push_str("## 레이어\n\n");
    out.push_str("| 폴더 | 역할 | 규칙 |\n| --- | --- | --- |\n");
    out.push_str(&format!(
        "| `{}/` | 세계관·캐릭터·스토리의 단일 정본 | 모든 결과물은 여기서 파생된다. 설정이 바뀌면 여기부터 고친다. |\n",
        p.bible
    ));
    out.push_str(&format!(
        "| `{}/` | 원본 에셋(이미지·오디오·폰트) | `manifest.json`에 등록한다. 생성 규칙은 game-asset-contract 스킬을 따른다. |\n",
        p.assets
    ));
    out.push_str(&format!(
        "| `{}/<kind>/` | 결과물별 소스(게임 코드, 회차 원고, 스토리보드) | 각 폴더의 README가 그 형식의 규칙이다. |\n",
        p.outputs
    ));
    out.push_str(&format!(
        "| `{}/` | 생성 산출물 | git에 넣지 않는다. 원본에서 언제든 다시 만든다. |\n\n",
        p.build
    ));

    out.push_str("## 공통 규칙\n\n");
    out.push_str("1. 캐릭터·지명·용어는 bible의 표기를 그대로 쓴다. 새 이름이 필요하면 bible에 먼저 추가한다.\n");
    out.push_str("2. 결과물 폴더끼리 서로를 import하지 않는다. 공유할 것은 bible이나 assets로 올린다.\n");
    out.push_str("3. 에셋 파일명은 `<대상>_<상태>_<WxH>.png` 형식이고 실제 크기와 일치해야 한다.\n");
    out.push_str("4. 생성된 파일은 build/ 에만 쓴다. 원본을 덮어쓰지 않는다.\n");
    out.push_str("5. 회차·챕터·포스트는 두 자리 번호 접두사(`01-`, `02-`)로 순서를 고정한다.\n");
    out.push_str("6. 작업 전에 `codeg-project.json`의 `outputs`를 읽고, 없는 결과물 폴더는 만들지 않는다.\n\n");

    out.push_str("## 결과물\n\n");
    for kind in &manifest.outputs {
        let line = match kind {
            OutputKind::Game => "- `game/`: 게임 소스와 GDD. 장면 문서는 `content/`, 엔진 코드는 `src/`.",
            OutputKind::Webtoon => "- `webtoon/`: 세로 스크롤 회차. 회차마다 스크립트(`script.md`)와 컷 목록(`cuts.md`).",
            OutputKind::Instatoon => "- `instatoon/`: 정사각 1080×1080, 10장 이내 캐러셀. 포스트마다 캡션과 해시태그.",
            OutputKind::Novel => "- `novel/`: 챕터 원고 Markdown. 챕터 머리에 시점·시간·등장인물을 적는다.",
            OutputKind::Video => "- `video/`: 스토리보드와 샷 리스트. 샷마다 길이·카메라·대사·생성 프롬프트.",
        };
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');

    if let Some(engine) = &manifest.engine {
        out.push_str("## 게임 엔진\n\n");
        out.push_str(&format!(
            "- 엔진: `{}` v{}\n- 진입점: `{}`\n- 실행: `{}`\n- 엔진 파일 버전을 올리면 `codeg-project.json`의 `engine.version`도 같이 올린다.\n\n",
            engine.id, engine.version, engine.entry, engine.start
        ));
        out.push_str(SCENE_CONTRACT_RULES);
    }

    out.push_str("## 에이전트 역할\n\n");
    out.push_str("`codeg-project.json`의 `agents`는 역할별 선호 에이전트다. `null`이면 사용자가 선택한 에이전트를 쓴다. 역할: `writing`(스토리·원고), `art`(에셋·이미지 프롬프트), `code`(게임 코드), `video`(스토리보드·영상 생성).\n");
    out
}

// ---------------------------------------------------------------------------
// Static scaffold files
// ---------------------------------------------------------------------------

const GITIGNORE: &str = "# generated output — always rebuildable from bible/, assets/, outputs/\nbuild/*\n!build/.gitkeep\n\nnode_modules/\n.DS_Store\n*.log\n";

const BIBLE_README: &str = "# bible — 세계관 정본\n\n모든 결과물(게임·웹툰·소설·영상)이 참조하는 단일 정본이다.\n\n- `world.md`: 세계관, 규칙, 지리, 역사, 용어집\n- `characters/`: 캐릭터 한 명당 파일 하나. `_template.md`를 복사한다.\n- `story/`: 시놉시스, 플롯, 에피소드 개요\n\n설정 충돌이 생기면 여기서 먼저 정리하고 결과물을 고친다.\n";

const WORLD_MD: &str = "# 세계관\n\n## 한 줄 요약\n\n## 배경과 시대\n\n## 규칙 (마법·기술·사회)\n\n## 주요 장소\n\n## 용어집\n\n| 용어 | 뜻 | 비고 |\n| --- | --- | --- |\n";

const CHARACTERS_README: &str = "# characters\n\n캐릭터마다 `<slug>.md` 하나. 파일명은 소문자 영문 slug(`mina.md`)로 쓰고, 표기명은 파일 안에 적는다.\n\n에셋은 `assets/characters/<slug>/`에 두고, 파일 안 \"비주얼\" 절에서 참조한다.\n";

const CHARACTER_TEMPLATE: &str = "# (이름)\n\n- slug: \n- 역할: 주인공 / 조연 / 적대자\n- 나이·성별: \n- 한 줄 소개: \n\n## 성격\n\n## 목표와 결핍\n\n## 관계\n\n| 상대 | 관계 | 비고 |\n| --- | --- | --- |\n\n## 비주얼\n\n- 키·체형: \n- 머리·눈 색: \n- 기본 의상: \n- 시그니처 소품: \n- 참조 에셋: `assets/characters/<slug>/`\n\n## 말투 샘플\n\n> \n";

const STORY_README: &str = "# story\n\n- `synopsis.md`: 전체 시놉시스와 3막 구조\n- `episodes/` (선택): 에피소드·챕터 단위 개요. 결과물 폴더의 회차는 여기 개요를 참조한다.\n";

const SYNOPSIS_MD: &str = "# 시놉시스\n\n## 로그라인\n\n## 3막 구조\n\n### 1막 — 설정\n\n### 2막 — 대립\n\n### 3막 — 해결\n\n## 테마\n";

const ASSETS_README: &str = "# assets — 원본 에셋\n\n이미지·오디오·폰트의 원본. 가공본은 `build/`에 생성한다.\n\n- `characters/<slug>/`: 캐릭터 시트, 표정, 스프라이트\n- `backgrounds/`: 배경, 장소\n- `ui/`: UI 프레임, 아이콘\n\n규칙은 `game-asset-contract` 스킬을 따른다. 특히:\n\n- 파일명 `<대상>_<상태>_<WxH>.png`, 실제 크기와 일치\n- UI 프레임은 full-bleed(투명 여백 없음), 진짜 알파 채널\n- 스프라이트 시트는 `manifest.json`에 프레임 수·그리드 선언\n\n검증: `python3 validate_assets.py assets --container 1080x1920`\n";

const ASSETS_MANIFEST: &str = "{\n  \"schema\": 1,\n  \"container\": \"1080x1920\",\n  \"assets\": []\n}\n";

const GAME_README: &str = "# game\n\n- `GDD.md`: 게임 디자인 문서. 규칙·수치·화면 크기의 정본.\n- `content/`: Tinysolver Studio 장면 문서(`*.studio.json`). 엔진과 무관한 편집 데이터.\n- `src/`: 이 게임의 규칙(`main.js`, `scripts/`). 엔진은 Tinysolver Studio가 제공하며 여기에 없다 — `ENGINE.md` 참고.\n- `ENGINE.md`: 엔진 API.\n- `index.html`: 미리보기 진입점.\n\nGDD 안의 수치와 코드가 다르면 GDD가 우선한다. 코드를 GDD에 맞춘다.\n";

const GAME_CONTENT_README: &str = "# content — 장면 문서\n\n장면마다 `<scene>.studio.json` 하나. 엔진(`codeg-engine`)과 Tinysolver Studio 편집기가 **같은 파일**을 읽는다. 편집기에서 고치면 자동 저장되고, 에이전트가 파일을 고치면 편집기와 미리보기가 다시 읽는다.\n\n```json\n{\n  \"schema\": 1,\n  \"id\": \"main\",\n  \"name\": \"첫 장면\",\n  \"document\": {\n    \"container\": { \"width\": 1080, \"height\": 1920 },\n    \"assets\": [{ \"id\": \"hero_idle\", \"file\": \"characters/hero/hero_idle_120x180.png\", \"width\": 120, \"height\": 180 }],\n    \"nodes\": [\n      { \"id\": \"hero\", \"parent\": \"root\", \"type\": \"sprite\",\n        \"transform\": { \"x\": 540, \"y\": 1500, \"w\": 120, \"h\": 180, \"anchor\": \"bottom-center\", \"z\": 10 },\n        \"props\": { \"asset\": \"hero_idle\", \"interactive\": true, \"onClick\": \"act_hero\", \"placeholder\": \"#e8d5a3\" } }\n    ]\n  },\n  \"logic\": { \"actions\": { \"act_hero\": [{ \"op\": \"say\", \"text\": \"안녕\" }] } }\n}\n```\n\n- 좌표: 컨테이너 픽셀, 원점 좌상단, y 아래 방향. `anchor`는 `top-left`·`center`·`bottom-center`.\n- `parent`: 다른 노드 id면 그 노드의 좌상단 기준 상대 좌표. 없는 id(`root`, `ui`)는 화면 원점.\n- `z`: 클수록 앞. `props.visible: false`면 숨김.\n- `type`: `sprite`(에셋 또는 `placeholder` 색), `rect`(`props.color`), `text`(`props.text`·`size`·`color`).\n- `assets[].file`: `assets/` 기준 상대 경로. 파일이 아직 없으면 `\"missing\": true`로 두면 엔진이 플레이스홀더를 그린다.\n- `logic`은 엔진의 것이다. 편집기는 그대로 보존한다.\n\n편집기가 다루는 것: `transform`, `props`의 `visible`·`asset`·`text`·`size`·`color`·`interactive`·`onClick`·`opacity`·`rotation`·`scale`·`flipX`·`script`(행동), 그리고 `logic.actions`(액션 단계). 그 밖의 필드는 손대지 않고 보존한다. 행동과 액션에 쓸 수 있는 이름은 `../ENGINE.md`에 있다.\n";

const GDD_MD: &str = "# GDD\n\n## 개요\n\n- 장르: \n- 플랫폼: 웹\n- 화면: 1080×1920 (세로) — 한 값만 쓴다\n\n## 핵심 루프\n\n## 규칙과 수치\n\n| 항목 | 값 | 근거 |\n| --- | --- | --- |\n\n## 화면 목록\n\n## 필요한 에셋\n\n`assets/manifest.json`과 일치해야 한다.\n";

/// First scene of a new game: something visible immediately, in the schema
/// the engine and the Studio share. Kept tiny so an agent's first edit is a
/// change, not a rewrite.
const STARTER_SCENE: &str = r##"{
  "schema": 1,
  "id": "main",
  "name": "첫 장면",
  "document": {
    "container": { "width": 1080, "height": 1920 },
    "assets": [],
    "nodes": [
      { "id": "bg", "parent": "root", "type": "rect",
        "transform": { "x": 0, "y": 0, "w": 1080, "h": 1920, "anchor": "top-left", "z": 0 },
        "props": { "color": "#1b1b2f", "interactive": false } },
      { "id": "title", "parent": "root", "type": "text",
        "transform": { "x": 90, "y": 200, "w": 900, "h": 160, "anchor": "top-left", "z": 10 },
        "props": { "text": "새 장면", "size": 96, "color": "#f2efe6", "align": "center" } },
      { "id": "hero", "parent": "root", "type": "sprite",
        "transform": { "x": 540, "y": 1500, "w": 120, "h": 180, "anchor": "bottom-center", "z": 20 },
        "props": { "asset": null, "placeholder": "#ffb347", "interactive": true, "onClick": "act_hero", "script": "float" } },
      { "id": "hint", "parent": "root", "type": "text",
        "transform": { "x": 90, "y": 1600, "w": 900, "h": 80, "anchor": "top-left", "z": 10 },
        "props": { "text": "주인공을 눌러 보세요", "size": 44, "color": "#9aa4c7", "align": "center", "visible": false } }
    ]
  },
  "logic": {
    "actions": {
      "act_hero": [{ "op": "toggle", "id": "hint" }, { "op": "shake", "id": "hero" }]
    }
  }
}
"##;

const SCENE_CONTRACT_RULES: &str = "## 장면 문서와 미리보기\n\n- 장면은 `outputs/game/content/<scene>.studio.json`이고 엔진과 Tinysolver Studio가 같은 파일을 읽는다. 스키마는 `outputs/game/content/README.md`에 있다.\n- 엔진은 Tinysolver Studio가 제공하는 `codeg-engine`이다(`outputs/game/ENGINE.md`). 프로젝트에 엔진 코드는 없고, 복사해 와서 고치지도 않는다. 이 게임만의 규칙은 `outputs/game/src/scripts/index.js`의 스크립트와 `src/main.js`의 `ops`·`setup`에 쓰고, 노드의 `props.script`로 붙인다. 엔진에 없는 것은 `engine.THREE`·`engine.world`로 직접 그린다.\n- 스크립트는 플레이 모드에서만 돈다. 편집 모드에서는 장면이 문서 그대로 그려진다.\n- Tinysolver Studio 안에서 열렸다면 `studio_list_scenes`·`studio_read_scene`·`studio_apply_scene_commands`·`studio_build`·`studio_publish` 도구가 있다. 배치·표시·텍스트·색·추가/삭제/순서는 `studio_apply_scene_commands`로 고친다(검증되고 원자적이며 모르는 필드를 보존한다). `logic.actions`와 엔진 코드는 파일을 직접 고친다.\n- 미리보기는 런타임 오류(예외·거부된 프로미스·console.error)를 편집기에 올리고, 사용자가 그것을 대화로 보낼 수 있다. 오류를 삼키지 말고 던지거나 console.error로 남긴다.\n- 배포 빌드는 Tinysolver Studio의 빌드 버튼이 만든다. `build/game/<version>/`에 `outputs/game`과 `assets`를 복사하고(문서 `*.md`는 빠진다) 엔진과 플랫폼 층(`__codeg/`)을 넣어 zip을 만든다. 빌드는 CDN 없이 혼자 돈다.\n- 같은 게임이 미리보기 · 독립 웹 · afterplay · 데스크톱 · 폰 앱에서 돈다. 저장 · 플레이어 · 순위 · 공유 · 광고는 `codeg-platform`(`import { platform } from \"codeg-platform\"`)으로만 부르고, 없는 능력은 `platform.has()`로 보고 UI를 숨긴다. 바깥 네트워크(CDN · 웹폰트) · `localStorage` 직접 · `alert`/`window.open` · Service Worker를 쓰지 않는다 — `outputs/game/ENGINE.md`의 \"어디서든 돌려면\". 빌드 결과의 `warnings`가 이 규칙 위반이다. 있으면 고친다.\n- 출시는 빌드 목록의 출시 버튼이나 `studio_publish`다. 기본은 Tinysolver Studio가 `/play/<프로젝트>/`로 서빙하는 링크이고, 외부 호스트는 `codeg-project.json`의 `publish.command`(빌드 폴더는 `$CODEG_BUILD_DIR`)로 올린다. 어느 호스트·계정인지는 사용자에게 묻는다. 빌드 전 명령이 필요하면 `codeg-project.json`의 `engine.build`에 적는다.\n\n";

const THREE_INDEX_HTML: &str = r#"<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>game</title>
    <style>
      html, body { margin: 0; height: 100%; background: #111; }
      canvas { display: block; }
    </style>
    <script type="importmap">
      {
        "imports": {
          "three": "../../__codeg/vendor/three.module.min.js",
          "codeg-engine": "../../__codeg/engine/three-web/runtime.js",
          "codeg-platform": "../../__codeg/platform/current.js"
        }
      }
    </script>
  </head>
  <body>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
"#;

const GAME_MAIN_JS: &str = include_str!("content_project_game_main.js");
const GAME_SCRIPTS_JS: &str = include_str!("content_project_game_scripts.js");

const WEBTOON_README: &str = "# webtoon\n\n세로 스크롤 웹툰. 회차마다 `episodes/NN-<slug>/` 폴더.\n\n- `script.md`: 대사와 지문. 컷 번호로 나눈다.\n- `cuts.md`: 컷 목록 — 컷마다 구도, 등장인물, 배경, 이미지 생성 프롬프트.\n- 완성 이미지는 `build/webtoon/NN/`에 생성한다.\n\n캔버스: 폭 800px 기준, 컷 사이 여백으로 호흡을 조절한다.\n";

const INSTATOON_README: &str = "# instatoon\n\n인스타그램 캐러셀용 짧은 툰. 포스트마다 `posts/NN-<slug>/` 폴더.\n\n- `post.md`: 슬라이드별 텍스트·구도(최대 10장), 캡션, 해시태그.\n- 이미지: 1080×1080 정사각. 첫 장이 썸네일이므로 후킹 문장을 넣는다.\n- 완성 이미지는 `build/instatoon/NN/`에 생성한다.\n\n홍보용이면 마지막 장에 CTA(게임 링크, 다음 화 예고)를 넣는다.\n";

const NOVEL_README: &str = "# novel\n\n챕터마다 `chapters/NN-<slug>.md`.\n\n각 파일 머리에 다음을 적는다.\n\n```\n---\npov: (시점 인물 slug)\ntime: (작중 시간)\ncharacters: [slug, slug]\n---\n```\n\n분량 목표와 문체 규칙은 `bible/story/synopsis.md`의 테마 절을 따른다.\n";

const VIDEO_README: &str = "# video\n\n영상 생성용 스토리보드. 영상마다 `storyboards/NN-<slug>.md`, `_template.md`를 복사한다.\n\n- 샷 단위로 길이(초), 카메라, 대사/자막, 이미지·영상 생성 프롬프트를 적는다.\n- 참조 이미지는 `assets/`의 원본을 가리킨다.\n- 렌더 결과와 중간 프레임은 `build/video/NN/`에 둔다.\n";

const STORYBOARD_TEMPLATE: &str = "# (제목)\n\n- 목적: 홍보 / 예고편 / 컷신\n- 길이: 초\n- 비율: 9:16 / 16:9\n- 음악·톤: \n\n## 샷 리스트\n\n| # | 길이 | 카메라 | 내용 | 대사·자막 | 생성 프롬프트 | 참조 에셋 |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | 3s | | | | | |\n";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_layout_and_round_trips_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().to_string_lossy().to_string();
        let path = create_content_project(
            "my-story".into(),
            target,
            "web-three".into(),
            vec!["game".into(), "video".into(), "instatoon".into()],
        )
        .await
        .unwrap();
        let root = Path::new(&path);

        for rel in [
            MANIFEST_FILE,
            "AGENTS.md",
            "CLAUDE.md",
            "README.md",
            ".gitignore",
            "bible/world.md",
            "bible/characters/_template.md",
            "bible/story/synopsis.md",
            "assets/manifest.json",
            "build/.gitkeep",
            "outputs/game/index.html",
            "outputs/game/src/main.js",
            "outputs/game/src/scripts/index.js",
            "outputs/game/ENGINE.md",
            "outputs/game/GDD.md",
            "outputs/game/content/README.md",
            "outputs/video/storyboards/_template.md",
            "outputs/instatoon/README.md",
        ] {
            assert!(root.join(rel).is_file(), "missing {rel}");
        }
        assert!(!root.join("outputs/novel").exists());
        assert!(!root.join("outputs/webtoon").exists());

        let manifest = read_content_project(path.clone()).await.unwrap().unwrap();
        assert_eq!(manifest.schema, MANIFEST_SCHEMA);
        assert_eq!(manifest.name, "my-story");
        assert_eq!(manifest.template, "web-three");
        // Sorted, deduplicated, kebab-case on disk.
        assert_eq!(
            manifest.outputs,
            vec![OutputKind::Game, OutputKind::Instatoon, OutputKind::Video]
        );
        assert_eq!(manifest.engine.as_ref().map(|e| e.id.as_str()), Some("three-web"));
        assert_eq!(manifest.agents.len(), 4);

        let rules = fs::read_to_string(root.join("AGENTS.md")).unwrap();
        assert!(rules.contains("three-web"));
        assert!(rules.contains("`instatoon/`"));
        assert!(!rules.contains("`novel/`"));
    }

    #[tokio::test]
    async fn story_template_without_game_has_no_engine_or_game_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = create_content_project(
            "tale".into(),
            dir.path().to_string_lossy().to_string(),
            "story".into(),
            vec!["novel".into(), "webtoon".into(), "novel".into()],
        )
        .await
        .unwrap();
        let manifest = read_content_project(path.clone()).await.unwrap().unwrap();
        assert!(manifest.engine.is_none());
        assert_eq!(manifest.outputs, vec![OutputKind::Webtoon, OutputKind::Novel]);
        assert!(!Path::new(&path).join("outputs/game").exists());
    }

    #[tokio::test]
    async fn game_output_on_story_template_still_gets_no_engine() {
        let dir = tempfile::tempdir().unwrap();
        let path = create_content_project(
            "tale".into(),
            dir.path().to_string_lossy().to_string(),
            "story".into(),
            vec!["game".into()],
        )
        .await
        .unwrap();
        let manifest = read_content_project(path.clone()).await.unwrap().unwrap();
        assert!(manifest.engine.is_none());
        assert!(Path::new(&path).join("outputs/game/GDD.md").is_file());
        assert!(!Path::new(&path).join("outputs/game/index.html").exists());
    }

    #[tokio::test]
    async fn workspace_binary_write_creates_parents_and_guards_with_etag() {
        use crate::commands::folders::write_workspace_file_base64;
        use base64::Engine as _;
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s.as_bytes());

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let rel = "outputs/game/content/main.studio.json".to_string();

        // Create with parents.
        let first = write_workspace_file_base64(root.clone(), rel.clone(), b64("one"), None)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(&rel)).unwrap(), "one");

        // Matching etag: accepted, etag rotates.
        let second = write_workspace_file_base64(
            root.clone(),
            rel.clone(),
            b64("two"),
            Some(first.etag.clone()),
        )
        .await
        .unwrap();
        assert_ne!(first.etag, second.etag);

        // Stale etag: refused, file untouched.
        let err = write_workspace_file_base64(root.clone(), rel.clone(), b64("three"), Some(first.etag))
            .await
            .unwrap_err();
        assert!(matches!(err.code, crate::app_error::AppErrorCode::InvalidInput));
        assert_eq!(fs::read_to_string(dir.path().join(&rel)).unwrap(), "two");

        // Etag on a missing file: refused (someone deleted it).
        let err = write_workspace_file_base64(
            root.clone(),
            "outputs/game/content/other.json".into(),
            b64("x"),
            Some(second.etag),
        )
        .await
        .unwrap_err();
        assert!(matches!(err.code, crate::app_error::AppErrorCode::InvalidInput));

        // Confinement.
        assert!(write_workspace_file_base64(root.clone(), "../escape".into(), b64("x"), None)
            .await
            .is_err());
        assert!(write_workspace_file_base64(root, "bad base64".into(), "%%%".into(), None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn lists_scenes_and_packages_a_build() {
        let dir = tempfile::tempdir().unwrap();
        let path = create_content_project(
            "game".into(),
            dir.path().to_string_lossy().to_string(),
            "web-three".into(),
            vec!["game".into()],
        )
        .await
        .unwrap();
        let root = Path::new(&path);

        // The scaffold ships a starter scene the engine can load.
        let scenes = list_content_scenes(path.clone()).await.unwrap();
        assert_eq!(scenes.len(), 1);
        assert_eq!(scenes[0].id, "main");
        assert_eq!(scenes[0].name, "첫 장면");
        assert_eq!(scenes[0].path, "outputs/game/content/main.studio.json");
        fs::write(
            root.join("outputs/game/content/02-cave.studio.json"),
            r#"{"schema":1,"id":"02-cave","document":{"container":{"width":1,"height":1},"nodes":[]}}"#,
        )
        .unwrap();
        fs::write(root.join("outputs/game/content/notes.json"), "{}").unwrap();
        let ids: Vec<String> = list_content_scenes(path.clone())
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["02-cave", "main"]);
        // A plain folder lists nothing rather than failing.
        let plain = tempfile::tempdir().unwrap();
        assert!(list_content_scenes(plain.path().to_string_lossy().to_string())
            .await
            .unwrap()
            .is_empty());

        // Build: outputs/game + assets copied under the same relative layout.
        fs::write(root.join("assets/backgrounds/bg_1x1.png"), b"png").unwrap();
        fs::create_dir_all(root.join("outputs/game/node_modules/x")).unwrap();
        fs::write(root.join("outputs/game/node_modules/x/i.js"), "no").unwrap();
        assert!(list_content_builds(path.clone()).await.unwrap().is_empty());
        let build = build_content_project(path.clone()).await.unwrap();
        assert!(build.version.starts_with("v1-"));
        let out = Path::new(&build.dir);
        assert!(out.join("outputs/game/index.html").is_file());
        assert!(out.join("outputs/game/src/main.js").is_file());
        assert!(out.join("outputs/game/content/main.studio.json").is_file());
        // Self-contained: the managed runtime and Three.js ride along, and the
        // entry page references nothing off-host.
        assert!(out.join("__codeg/engine/three-web/runtime.js").is_file());
        assert!(out.join("__codeg/vendor/three.module.min.js").is_file());
        // The platform layer rides along with the build target's adapter.
        assert_eq!(build.target, "web");
        assert!(out.join("__codeg/platform/core.js").is_file());
        let adapter = fs::read_to_string(out.join("__codeg/platform/current.js")).unwrap();
        assert!(adapter.contains("makePlatform(\"web\""));
        // Only what runs: authoring docs stay behind.
        assert!(root.join("outputs/game/ENGINE.md").is_file());
        assert!(!out.join("outputs/game/ENGINE.md").exists());
        assert!(!out.join("outputs/game/GDD.md").exists());
        assert!(!out.join("outputs/game/README.md").exists());
        assert!(!out.join("assets/README.md").exists());
        assert!(!out.join("__codeg/engine/three-web/ENGINE.md").exists());
        // The scaffold keeps the rules it teaches.
        assert!(build.warnings.is_empty(), "{:?}", build.warnings);
        let page = fs::read_to_string(out.join("outputs/game/index.html")).unwrap();
        assert!(page.contains("../../__codeg/vendor/three.module.min.js"));
        assert!(page.contains("\"codeg-platform\": \"../../__codeg/platform/current.js\""));
        assert!(!page.contains("http://") && !page.contains("https://"));
        assert!(!root.join("__codeg").exists(), "never written into the project");
        assert!(out.join("assets/backgrounds/bg_1x1.png").is_file());
        assert!(!out.join("outputs/game/node_modules").exists());
        assert!(out.join("index.html").is_file());
        assert!(out.join(BUILD_INFO_FILE).is_file());
        assert!(build.size_bytes > 0);
        let zip = build.zip.as_deref().expect("zip written");
        assert!(Path::new(zip).is_file());
        let mut archive = zip::ZipArchive::new(fs::File::open(zip).unwrap()).unwrap();
        assert!(archive
            .by_name(&format!("{}/outputs/game/index.html", build.version))
            .is_ok());

        // Release it on the Studio's own link; the record lands in build-info.
        let registry = dir.path().join("data/published-games.json");
        let released = publish_content_build_in(&registry, path.clone(), None, "local".into())
            .await
            .unwrap();
        assert_eq!(released.version, build.version);
        assert_eq!(released.published[0].target, "local");
        assert_eq!(released.published[0].url.as_deref(), Some("/play/game/"));
        let served = crate::content_publish::serve_in(&registry, "game", "outputs/game/index.html").await;
        assert_eq!(served.status(), axum::http::StatusCode::OK);

        // No publish.command yet: a readable refusal, nothing recorded.
        let refused = publish_content_build_in(&registry, path.clone(), None, "command".into())
            .await
            .unwrap_err();
        assert!(refused.message.contains("publish.command"));

        // With one: placeholders and env vars reach the command, the last
        // URL it prints is the release address.
        let manifest_path = root.join(MANIFEST_FILE);
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        #[cfg(not(windows))]
        let command = "test -f \"$CODEG_BUILD_DIR/index.html\" && echo uploading https://example.test/progress && echo Published {name} {version} at https://example.test/game.";
        #[cfg(windows)]
        let command = "echo Published {name} {version} at https://example.test/game.";
        manifest["publish"] = serde_json::json!({ "command": command });
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
        let deployed = publish_content_build_in(&registry, path.clone(), Some(build.version.clone()), "command".into())
            .await
            .unwrap();
        assert_eq!(deployed.published.len(), 2, "local + command");
        let record = deployed.published.iter().find(|r| r.target == "command").unwrap();
        assert_eq!(record.url.as_deref(), Some("https://example.test/game"));
        assert!(record.log.contains(&format!("Published game {}", build.version)));

        manifest["publish"] = serde_json::json!({ "command": "echo nope && exit 3" });
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
        let failed = publish_content_build_in(&registry, path.clone(), None, "command".into())
            .await
            .unwrap_err();
        assert!(failed.message.contains("publish.command exited"));

        // Second build gets the next counter; listing is newest first.
        // A page from before the platform layer gets the import in the build
        // (the project file is left alone), and rule breaks become warnings.
        let entry_path = root.join("outputs/game/index.html");
        let current = fs::read_to_string(&entry_path).unwrap();
        let old_page = current.replace(
            ",\n          \"codeg-platform\": \"../../__codeg/platform/current.js\"",
            "",
        );
        assert_ne!(old_page, current);
        fs::write(&entry_path, &old_page).unwrap();
        fs::write(root.join("outputs/game/src/best.js"), "export const best = () => localStorage.getItem(\"best\")\n").unwrap();
        let second = build_content_project(path.clone()).await.unwrap();
        assert!(second.version.starts_with("v2-"));
        let second_page = fs::read_to_string(Path::new(&second.dir).join("outputs/game/index.html")).unwrap();
        assert!(second_page.contains("\"codeg-platform\": \"../../__codeg/platform/current.js\""));
        assert_eq!(fs::read_to_string(&entry_path).unwrap(), old_page);
        assert_eq!(second.warnings.len(), 1, "{:?}", second.warnings);
        assert!(second.warnings[0].starts_with("[2] outputs/game/src/best.js:1 · localStorage"));
        assert!(second.log.contains("compat: 1 warning(s)"));
        fs::remove_file(root.join("outputs/game/src/best.js")).unwrap();
        let listed = list_content_builds(path.clone()).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].version, second.version);

        // Re-pointing the link moves the `local` record to the new build.
        publish_content_build_in(&registry, path.clone(), None, "local".into())
            .await
            .unwrap();
        let listed = list_content_builds(path.clone()).await.unwrap();
        assert!(listed[0].published.iter().any(|r| r.target == "local"));
        assert!(!listed[1].published.iter().any(|r| r.target == "local"));
        assert!(listed[1].published.iter().any(|r| r.target == "command"), "other targets stay");
        assert!(unpublish_content_game_in(&registry, path.clone()).await.unwrap());
        let listed = list_content_builds(path.clone()).await.unwrap();
        assert!(listed.iter().all(|b| b.published.iter().all(|r| r.target != "local")));
        assert_eq!(
            crate::content_publish::serve_in(&registry, "game", "").await.status(),
            axum::http::StatusCode::NOT_FOUND
        );

        assert_eq!(last_url("see (https://a.test/x), then \"https://b.test/y\"."), Some("https://b.test/y".into()));
        assert_eq!(last_url("no links here"), None);

        // A failing engine.build leaves no directory behind.
        let mut manifest = read_content_project(path.clone()).await.unwrap().unwrap();
        manifest.engine.as_mut().unwrap().build = Some("exit 3".into());
        fs::write(root.join(MANIFEST_FILE), serde_json::to_string(&manifest).unwrap()).unwrap();
        let err = build_content_project(path.clone()).await.unwrap_err();
        assert!(err.message.contains("engine.build"), "{err:?}");
        assert_eq!(list_content_builds(path.clone()).await.unwrap().len(), 2);

        // No engine → refused.
        let story = create_content_project(
            "tale".into(),
            dir.path().to_string_lossy().to_string(),
            "story".into(),
            vec!["novel".into()],
        )
        .await
        .unwrap();
        assert!(build_content_project(story).await.is_err());
    }

    #[tokio::test]
    async fn rejects_bad_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().to_string_lossy().to_string();
        assert!(create_content_project("../x".into(), target.clone(), "story".into(), vec!["novel".into()])
            .await
            .is_err());
        assert!(create_content_project("ok".into(), target.clone(), "nope".into(), vec!["novel".into()])
            .await
            .is_err());
        assert!(create_content_project("ok".into(), target.clone(), "story".into(), vec![])
            .await
            .is_err());
        assert!(create_content_project("ok".into(), target.clone(), "story".into(), vec!["comic".into()])
            .await
            .is_err());
        // Nothing was left behind by the rejected calls.
        assert!(!dir.path().join("ok").exists());
    }

    #[tokio::test]
    async fn refuses_non_empty_target() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("taken")).unwrap();
        fs::write(dir.path().join("taken/file.txt"), "x").unwrap();
        let err = create_content_project(
            "taken".into(),
            dir.path().to_string_lossy().to_string(),
            "story".into(),
            vec!["novel".into()],
        )
        .await
        .unwrap_err();
        assert!(matches!(
            err.code,
            crate::app_error::AppErrorCode::AlreadyExists
        ));
    }

    #[tokio::test]
    async fn read_is_none_for_plain_folders_and_errs_on_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        assert!(read_content_project(path.clone()).await.unwrap().is_none());

        fs::write(
            dir.path().join(MANIFEST_FILE),
            r#"{"schema": 99, "name": "x", "created_at": "", "template": "story", "outputs": []}"#,
        )
        .unwrap();
        assert!(read_content_project(path).await.is_err());
    }
}
