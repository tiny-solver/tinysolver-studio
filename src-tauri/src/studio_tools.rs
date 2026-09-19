//! The companion's `studio_*` MCP tools, backed by the project folder.
//!
//! An agent working in a content project gets four verbs over the scenes the
//! Codeg Studio editor edits and the game engine runs:
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
use crate::studio_scene;

/// One studio operation, carried inside a broker request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StudioOp {
    ListScenes,
    ReadScene { scene: String },
    ApplyCommands { scene: String, commands: Value },
    Build,
}

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
    }
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
