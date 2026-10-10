//! The companion's `studio_*` MCP tools, backed by the project folder.
//!
//! An agent working in a content project gets four verbs over the scenes the
//! Tinysolver Studio editor edits and the game engine runs:
//! list, read, apply a validated command batch, build. Everything goes through
//! [`crate::studio_scene`] so an agent batch obeys the same rules as a drag in
//! the editor, and the file is written in place — the editor and the preview
//! notice the change through the ordinary workspace watch stream, so nothing
//! here has to talk to the frontend.
//!
//! Outcomes are `{ ok, note?, ... }` values. Domain failures (not a project,
//! scene missing, batch rejected) are `ok: false` with a readable note, not
//! transport errors: the LLM reads the note and adjusts.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::content_project as cp;
use crate::studio_assets;
use crate::studio_scene;
use crate::studio_set;

/// One studio operation, carried inside a broker request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StudioOp {
    ListScenes,
    ReadScene { scene: String },
    ApplyCommands { scene: String, commands: Value },
    Build,
    /// Release a build: `local` (the Studio's `/play/<slug>/`) or `command`
    /// (the manifest's `publish.command`). `version: None` → newest build.
    Publish {
        #[serde(default)]
        version: Option<String>,
        target: String,
    },
    /// The material register `<assets>/manifest.json` ([`crate::studio_assets`]).
    ListAssets,
    /// Fetch a URL into `<assets>/` and register it with its provenance.
    ImportAsset(studio_assets::ImportRequest),
    /// Call the project's generator (optionally feeding a material back in)
    /// and import the result.
    GenerateAsset(studio_assets::GenerateRequest),
    /// Set (or clear) where a material will be used (`use`, a preset id).
    UpdateAsset {
        id: String,
        #[serde(default, rename = "use")]
        use_for: Option<String>,
    },
    /// Set or clear `generate.url` in the manifest. The editor's Connect
    /// button; agents edit the manifest directly.
    ConnectGenerator {
        #[serde(default)]
        url: Option<String>,
    },
    /// What each step can be asked for — picture models (the generator's
    /// workflows and cloud ones), video workflows, 3D presets
    /// ([`studio_assets::options`]). `url` overrides the project's generator.
    GeneratorOptions {
        #[serde(default)]
        url: Option<String>,
    },
    /// Render a model material with the user's Blender ([`crate::studio_render`]).
    RenderAsset(crate::studio_render::RenderRequest),
    /// The first screen's step record, `<root>/studio-flow.json` (what was
    /// asked, which steps ran, which material each made). `null` when absent.
    ReadFlow,
    /// Replace the step record. The editor owns its shape; this only checks
    /// that it is an object and writes it atomically.
    WriteFlow { flow: Value },
    /// The film sets, `outputs/film/sets/*.set.json` ([`crate::studio_set`]).
    ListSets,
    /// One set, normalized, with its `issues` and the model files it names.
    ReadSet { set: String },
    /// A starter set (floor, three lights, one camera). Refuses an existing id.
    CreateSet {
        set: String,
        #[serde(default)]
        name: Option<String>,
    },
    /// A validated, atomic batch over a set — the 3D view's drags and the
    /// agents' edits both come through here.
    ApplySetCommands { set: String, commands: Value },
    /// Render one camera of a set with the user's Blender.
    RenderSet(crate::studio_render::SetRenderRequest),
}

/// Where the film sets live, from the project root.
pub const SETS_DIR: &str = "outputs/film/sets";

/// Where the first screen keeps its step record.
pub const FLOW_FILE: &str = "studio-flow.json";

/// Whether a folder is (or is shaped like) a content project, i.e. whether
/// the `studio_*` tools are worth exposing to an agent launched in it.
pub fn is_content_project(dir: &Path) -> bool {
    dir.join("codeg-project.json").is_file() || dir.join("outputs/game/content").is_dir()
}

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub async fn run(root: PathBuf, op: StudioOp) -> Value {
    if !root.is_absolute() || !root.is_dir() {
        return fail(format!("{} is not a directory", root.display()));
    }
    let root_str = root.to_string_lossy().to_string();
    match op {
        StudioOp::ListScenes => {
            let manifest = match cp::read_content_project(root_str.clone()).await {
                Ok(m) => m,
                Err(e) => return fail(e.message),
            };
            let scenes = match cp::list_content_scenes(root_str.clone()).await {
                Ok(s) => s,
                Err(e) => return fail(e.message),
            };
            let engine = manifest.as_ref().and_then(|m| m.engine.as_ref()).map(|e| {
                json!({ "id": e.id, "version": e.version, "entry": e.entry })
            });
            json!({
                "ok": true,
                "project": root_str,
                "name": manifest.as_ref().map(|m| m.name.clone()),
                "is_content_project": manifest.is_some(),
                "engine": engine,
                "content_dir": cp::game_content_dir(manifest.as_ref()),
                "scenes": scenes,
                "note": if scenes_note(&scenes) { "No scene yet. Create outputs/game/content/<id>.studio.json (schema in outputs/game/content/README.md), or open the Studio and press New scene." } else { "" },
            })
        }
        StudioOp::ReadScene { scene } => match read_scene(&root, &scene).await {
            Ok((path, file)) => json!({
                "ok": true,
                "scene": scene,
                "path": rel(&root, &path),
                "file": file,
            }),
            Err(note) => fail(note),
        },
        StudioOp::ApplyCommands { scene, commands } => {
            let (path, current) = match read_scene(&root, &scene).await {
                Ok(v) => v,
                Err(note) => return fail(note),
            };
            let next = match studio_scene::apply_commands(&current, &commands) {
                Ok(n) => n,
                Err(e) => return fail(format!("Batch rejected, nothing written: {e}")),
            };
            if let Err(e) = write_atomic(&path, &next).await {
                return fail(format!("Could not write {}: {e}", rel(&root, &path)));
            }
            let nodes = next["document"]["nodes"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0);
            json!({
                "ok": true,
                "scene": scene,
                "path": rel(&root, &path),
                "nodes": nodes,
                "changed": studio_scene::command_targets(&commands),
                "note": "Written. The Studio editor and the game preview pick the change up from disk.",
            })
        }
        StudioOp::Build => match cp::build_content_project(root_str).await {
            Ok(build) => json!({ "ok": true, "build": build }),
            Err(e) => fail(e.message),
        },
        StudioOp::Publish { version, target } => {
            match cp::publish_content_build(root_str, version, target.clone()).await {
                Ok(build) => {
                    let record = build.published.iter().find(|r| r.target == target).cloned();
                    json!({ "ok": true, "published": record, "version": build.version })
                }
                Err(e) => fail(match e.detail.as_deref() {
                    Some(detail) if !detail.trim().is_empty() => format!("{}\n{}", e.message, detail),
                    _ => e.message,
                }),
            }
        }
        StudioOp::ListAssets => studio_assets::list(&root).await,
        StudioOp::ImportAsset(req) => studio_assets::import(&root, req).await,
        StudioOp::GenerateAsset(req) => studio_assets::generate(&root, req).await,
        StudioOp::UpdateAsset { id, use_for } => studio_assets::update(&root, &id, use_for).await,
        StudioOp::ConnectGenerator { url } => studio_assets::connect(&root, url).await,
        StudioOp::GeneratorOptions { url } => studio_assets::options(&root, url).await,
        StudioOp::RenderAsset(req) => crate::studio_render::render(&root, req).await,
        StudioOp::ReadFlow => {
            let path = root.join(FLOW_FILE);
            match tokio::fs::read(&path).await {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(flow) => json!({ "ok": true, "flow": flow }),
                    Err(e) => fail(format!("{FLOW_FILE} is not valid JSON: {e}")),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "ok": true, "flow": null }),
                Err(e) => fail(format!("Could not read {FLOW_FILE}: {e}")),
            }
        }
        StudioOp::ListSets => list_sets(&root).await,
        StudioOp::ReadSet { set } => match read_set(&root, &set).await {
            Ok((path, file)) => {
                let mut out = describe_set(&root, &file).await;
                out["path"] = json!(rel(&root, &path));
                out
            }
            Err(note) => fail(note),
        },
        StudioOp::CreateSet { set, name } => create_set(&root, &set, name.as_deref()).await,
        StudioOp::ApplySetCommands { set, commands } => {
            let (path, current) = match read_set(&root, &set).await {
                Ok(v) => v,
                Err(note) => return fail(note),
            };
            let next = match studio_set::apply_commands(&current, &commands) {
                Ok(n) => n,
                Err(e) => return fail(format!("Batch rejected, nothing written: {e}")),
            };
            if let Err(e) = write_atomic(&path, &next).await {
                return fail(format!("Could not write {}: {e}", rel(&root, &path)));
            }
            let mut out = describe_set(&root, &next).await;
            out["path"] = json!(rel(&root, &path));
            out["changed"] = json!(studio_set::command_targets(&commands));
            out["note"] = json!("Written. The Studio's 3D set view picks the change up from disk.");
            out
        }
        StudioOp::RenderSet(req) => {
            let (_, file) = match read_set(&root, &req.set).await {
                Ok(v) => v,
                Err(note) => return fail(note),
            };
            crate::studio_render::render_set(&root, &file, req).await
        }
        StudioOp::WriteFlow { flow } => {
            if !flow.is_object() {
                return fail("flow must be an object");
            }
            match write_atomic(&root.join(FLOW_FILE), &flow).await {
                Ok(()) => json!({ "ok": true, "path": FLOW_FILE }),
                Err(e) => fail(format!("Could not write {FLOW_FILE}: {e}")),
            }
        }
    }
}

/// The editor's door to the same operations the MCP tools run: one command,
/// one implementation, so a button and an agent cannot drift apart.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn studio_run(root: String, op: StudioOp) -> Value {
    run(PathBuf::from(root.trim()), op).await
}

fn scenes_note(scenes: &[cp::ContentScene]) -> bool {
    scenes.is_empty()
}

async fn scene_path(root: &Path, scene: &str) -> Result<PathBuf, String> {
    if !studio_scene::is_id(scene) {
        return Err("scene: ids use letters, digits, - and _ (max 100)".into());
    }
    let manifest = cp::read_content_project(root.to_string_lossy().to_string())
        .await
        .map_err(|e| e.message)?;
    Ok(root
        .join(cp::game_content_dir(manifest.as_ref()))
        .join(format!("{scene}.studio.json")))
}

async fn read_scene(root: &Path, scene: &str) -> Result<(PathBuf, Value), String> {
    let path = scene_path(root, scene).await?;
    let shown = rel(root, &path);
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "Scene `{scene}` not found ({shown}). Call studio_list_scenes for the ids."
            ))
        }
        Err(e) => return Err(format!("Could not read {shown}: {e}")),
    };
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("{shown} is not valid JSON: {e}"))?;
    let parsed = studio_scene::parse_scene(&value).map_err(|e| format!("{shown}: {e}"))?;
    Ok((path, parsed))
}

fn set_path(root: &Path, set: &str) -> Result<PathBuf, String> {
    if !studio_scene::is_id(set) {
        return Err("set: ids use letters, digits, - and _ (max 100)".into());
    }
    Ok(root.join(SETS_DIR).join(format!("{set}.set.json")))
}

pub(crate) async fn read_set(root: &Path, set: &str) -> Result<(PathBuf, Value), String> {
    let path = set_path(root, set)?;
    let shown = rel(root, &path);
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "Set `{set}` not found ({shown}). Call studio_list_sets for the ids, or studio_create_set."
            ))
        }
        Err(e) => return Err(format!("Could not read {shown}: {e}")),
    };
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("{shown} is not valid JSON: {e}"))?;
    let parsed = studio_set::parse_set(&value).map_err(|e| format!("{shown}: {e}"))?;
    if parsed["id"] != set {
        return Err(format!("{shown}: its id is `{}`, the file name says `{set}`", parsed["id"].as_str().unwrap_or("")));
    }
    Ok((path, parsed))
}

/// A set as the tools hand it back: the file, what would spoil a render, and
/// where each model it names is (`assets/`-relative) so the 3D view can load
/// it.
async fn describe_set(root: &Path, file: &Value) -> Value {
    let manifest = studio_assets::project(root).await.ok().flatten();
    let dir = studio_assets::assets_dir(root, manifest.as_ref());
    let register = studio_assets::read_register(&dir).await.unwrap_or(Value::Null);
    let lookup = |asset: &str| {
        studio_assets::find(&register, asset).map(|e| studio_set::Material {
            is_model: studio_assets::kind_of(e["file"].as_str().unwrap_or("")) == "model",
            rigged: e.get("bones").is_some(),
        })
    };
    let issues = studio_set::issues(file, lookup);
    let mut models = serde_json::Map::new();
    for list in ["props", "actors"] {
        for item in file[list].as_array().into_iter().flatten() {
            let asset = item["asset"].as_str().unwrap_or("");
            if let Some(e) = studio_assets::find(&register, asset) {
                let f = e["file"].as_str().unwrap_or("");
                if studio_assets::kind_of(f) == "model" && dir.join(f).is_file() {
                    models.insert(asset.to_string(), json!(f));
                }
            }
        }
    }
    json!({
        "ok": true,
        "set": file["id"],
        "file": file,
        "issues": issues,
        "models": models,
        "assets_dir": rel(root, &dir),
    })
}

async fn list_sets(root: &Path) -> Value {
    let dir = root.join(SETS_DIR);
    let mut sets = Vec::new();
    if let Ok(mut read) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = read.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".set.json") else { continue };
            let summary = match read_set(root, stem).await {
                Ok((_, s)) => json!({
                    "id": stem,
                    "name": s["name"],
                    "duration": s["duration"],
                    "props": s["props"].as_array().map(Vec::len),
                    "actors": s["actors"].as_array().map(Vec::len),
                    "cameras": s["cameras"].as_array().map(|c| c.iter().map(|c| c["id"].clone()).collect::<Vec<_>>()),
                }),
                Err(note) => json!({ "id": stem, "error": note }),
            };
            sets.push(summary);
        }
    }
    sets.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({
        "ok": true,
        "dir": SETS_DIR,
        "sets": sets,
        "note": if sets.is_empty() { "No set yet. studio_create_set makes one (floor, lights, a camera); the schema is in outputs/film/sets/README.md once it exists." } else { "" },
    })
}

async fn create_set(root: &Path, set: &str, name: Option<&str>) -> Value {
    let path = match set_path(root, set) {
        Ok(p) => p,
        Err(note) => return fail(note),
    };
    if path.exists() {
        return fail(format!("Set `{set}` already exists ({}).", rel(root, &path)));
    }
    let file = match studio_set::parse_set(&studio_set::starter(set, name)) {
        Ok(f) => f,
        Err(e) => return fail(e),
    };
    let dir = root.join(SETS_DIR);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return fail(format!("Could not create {SETS_DIR}: {e}"));
    }
    let readme = dir.join("README.md");
    if !readme.exists() {
        let _ = tokio::fs::write(&readme, SETS_README).await;
    }
    if let Err(e) = write_atomic(&path, &file).await {
        return fail(format!("Could not write {}: {e}", rel(root, &path)));
    }
    let mut out = describe_set(root, &file).await;
    out["path"] = json!(rel(root, &path));
    out
}

/// Written next to the first set, for the agents that edit them by hand.
pub const SETS_README: &str = include_str!("studio_set_readme.md");

async fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut body = serde_json::to_string_pretty(value)?;
    body.push('\n');
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, body).await?;
    tokio::fs::rename(&tmp, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = cp::create_content_project(
            "tools-check".into(),
            dir.path().to_string_lossy().to_string(),
            "web-three".into(),
            vec!["game".into()],
        )
        .await
        .unwrap();
        assert!(is_content_project(Path::new(&path)));
        dir
    }

    #[tokio::test]
    async fn list_read_apply_round_trip() {
        let dir = project().await;
        let root = dir.path().join("tools-check");

        let listed = run(root.clone(), StudioOp::ListScenes).await;
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["scenes"][0]["id"], "main");
        assert_eq!(listed["engine"]["id"], "three-web");

        let read = run(root.clone(), StudioOp::ReadScene { scene: "main".into() }).await;
        assert_eq!(read["ok"], true);
        assert_eq!(read["path"], "outputs/game/content/main.studio.json");
        let hero_x = read["file"]["document"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "hero")
            .map(|n| n["transform"]["x"].clone())
            .unwrap();

        let applied = run(
            root.clone(),
            StudioOp::ApplyCommands {
                scene: "main".into(),
                commands: json!([{ "type": "node.update", "id": "hero", "transform": { "x": 123 } }]),
            },
        )
        .await;
        assert_eq!(applied["ok"], true, "{applied}");
        assert_eq!(applied["changed"][0], "hero");

        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("outputs/game/content/main.studio.json")).unwrap(),
        )
        .unwrap();
        let hero = on_disk["document"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "hero")
            .unwrap();
        assert_eq!(hero["transform"]["x"], 123);
        assert_ne!(hero["transform"]["x"], hero_x);
        assert!(on_disk["logic"].is_object(), "engine-owned fields survive");
        assert!(!root.join("outputs/game/content/main.json.tmp").exists());
    }

    #[tokio::test]
    async fn flow_round_trips_and_starts_empty() {
        let tmp = project().await;
        let root = tmp.path().join("tools-check");
        let r = run(root.clone(), StudioOp::ReadFlow).await;
        assert_eq!(r, json!({ "ok": true, "flow": null }));
        let flow = json!({ "schema": 1, "prompt": "a teacup", "steps": { "image": { "material": "teacup" } } });
        assert_eq!(run(root.clone(), StudioOp::WriteFlow { flow: flow.clone() }).await["ok"], true);
        assert_eq!(run(root.clone(), StudioOp::ReadFlow).await["flow"], flow);
        assert_eq!(run(root, StudioOp::WriteFlow { flow: json!([1]) }).await["ok"], false);
    }

    #[tokio::test]
    async fn sets_create_edit_and_report_issues() {
        let tmp = project().await;
        let root = tmp.path().join("tools-check");
        let listed = run(root.clone(), StudioOp::ListSets).await;
        assert_eq!(listed["sets"], json!([]));
        assert!(listed["note"].as_str().unwrap().contains("studio_create_set"));

        let made = run(root.clone(), StudioOp::CreateSet { set: "cafe".into(), name: Some("카페".into()) }).await;
        assert_eq!(made["ok"], true, "{made}");
        assert_eq!(made["path"], "outputs/film/sets/cafe.set.json");
        assert!(root.join("outputs/film/sets/README.md").is_file());
        assert_eq!(made["issues"], json!([]));
        let again = run(root.clone(), StudioOp::CreateSet { set: "cafe".into(), name: None }).await;
        assert!(again["note"].as_str().unwrap().contains("already exists"));

        let applied = run(
            root.clone(),
            StudioOp::ApplySetCommands {
                set: "cafe".into(),
                commands: json!([
                    { "type": "add", "kind": "actor", "item": { "id": "mina", "asset": "ghost", "motion": "walk" } },
                    { "type": "key.set", "id": "cam_a", "key": { "t": 3, "position": [2, 1.5, 4], "target": [0, 1, 0] } }
                ]),
            },
        )
        .await;
        assert_eq!(applied["ok"], true, "{applied}");
        assert_eq!(applied["changed"], json!(["mina", "cam_a"]));
        assert!(applied["issues"][0].as_str().unwrap().contains("`ghost` is not in"));
        let read = run(root.clone(), StudioOp::ReadSet { set: "cafe".into() }).await;
        assert_eq!(read["file"]["cameras"][0]["keys"].as_array().unwrap().len(), 2);
        assert_eq!(read["file"]["name"], "카페");

        let rejected = run(
            root.clone(),
            StudioOp::ApplySetCommands { set: "cafe".into(), commands: json!([{ "type": "remove", "id": "nope" }]) },
        )
        .await;
        assert!(rejected["note"].as_str().unwrap().contains("nothing written"));
        let listed = run(root.clone(), StudioOp::ListSets).await;
        assert_eq!(listed["sets"][0]["id"], "cafe");
        assert_eq!(listed["sets"][0]["actors"], 1);
        let missing = run(root.clone(), StudioOp::ReadSet { set: "nope".into() }).await;
        assert!(missing["note"].as_str().unwrap().contains("studio_list_sets"));
        let bad = run(root, StudioOp::ReadSet { set: "../x".into() }).await;
        assert_eq!(bad["ok"], false);
    }

    #[tokio::test]
    async fn failures_are_readable_outcomes() {
        let dir = project().await;
        let root = dir.path().join("tools-check");

        let missing = run(root.clone(), StudioOp::ReadScene { scene: "nope".into() }).await;
        assert_eq!(missing["ok"], false);
        assert!(missing["note"].as_str().unwrap().contains("studio_list_scenes"));

        let bad_id = run(root.clone(), StudioOp::ReadScene { scene: "../x".into() }).await;
        assert_eq!(bad_id["ok"], false);

        let rejected = run(
            root.clone(),
            StudioOp::ApplyCommands {
                scene: "main".into(),
                commands: json!([{ "type": "node.update", "id": "ghost", "transform": { "x": 1 } }]),
            },
        )
        .await;
        assert_eq!(rejected["ok"], false);
        assert!(rejected["note"].as_str().unwrap().contains("nothing written"));

        let not_dir = run(root.join("does-not-exist"), StudioOp::ListScenes).await;
        assert_eq!(not_dir["ok"], false);

        // A plain folder still lists (empty) under the default layout.
        let plain = tempfile::tempdir().unwrap();
        let listed = run(plain.path().to_path_buf(), StudioOp::ListScenes).await;
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["is_content_project"], false);
        assert_eq!(listed["scenes"].as_array().unwrap().len(), 0);
    }
}
