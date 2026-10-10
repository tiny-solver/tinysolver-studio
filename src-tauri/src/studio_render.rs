//! Render a model material with the Blender on the user's machine.
//!
//! The Studio does not ship Blender and does not render remotely
//! (decide bv-where A): it finds the install — `render.blender` in
//! `codeg-project.json`, `$BLENDER`, `PATH`, then the standard places per OS —
//! and runs it headless with an embedded script ([`SCRIPT`]). Blender writes
//! the video itself (its built-in FFmpeg), so no separate ffmpeg is needed.
//!
//! The result lands in `<assets>/generated/renders/` as materials: the clip
//! (`kind: video`) and one still per keyframe (`kind: image`), each with its
//! provenance (`source.kind: render`, the model it came from, the camera and
//! the Blender that drew it). A still is what the video generator takes as
//! its first frame (decide bv-route A: keyframe → i2v).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::studio_assets;

/// The Blender side. Reads a job JSON, writes `result.json`.
pub const SCRIPT: &str = include_str!("studio_render.py");
/// Longest a render may take before it is stopped.
const TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RENDER_DIR: &str = "generated/renders";

/// What `render_asset` is asked to draw.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct RenderRequest {
    /// The model material (GLB/glTF) to render.
    pub from: String,
    /// `turntable` (camera circles once, video + stills), `still`, or `walk`
    /// (a rigged model takes a procedural stride in place, video + stills).
    #[serde(default)]
    pub mode: Option<String>,
    /// Turntable length in frames at 24 fps. Default 72 (3 s).
    #[serde(default)]
    pub frames: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Camera distance; the model is scaled to height 2. Default 6.2.
    #[serde(default)]
    pub cam_dist: Option<f64>,
    /// Where the camera starts around the model, degrees (0 = front).
    #[serde(default)]
    pub yaw: Option<f64>,
    /// Camera height angle, degrees. Default 8.
    #[serde(default)]
    pub pitch: Option<f64>,
    /// Frames saved as stills. Default `[1]`.
    #[serde(default)]
    pub keyframes: Option<Vec<u32>>,
    /// Id for the new materials (stills get `-fNNN`).
    #[serde(default)]
    pub id: Option<String>,
}

/// The job handed to the script, after defaults and bounds.
pub fn job(req: &RenderRequest, model: &Path, out: &Path) -> Result<Value, String> {
    let mode = req.mode.as_deref().unwrap_or("turntable");
    if !["turntable", "still", "walk"].contains(&mode) {
        return Err("mode: `turntable`, `still` or `walk`".into());
    }
    let frames = match mode {
        "still" => 1,
        "walk" => req.frames.unwrap_or(48),
        _ => req.frames.unwrap_or(72),
    };
    if !(1..=720).contains(&frames) {
        return Err("frames: 1–720 (24 per second)".into());
    }
    // H.264 wants even sides.
    let side = |v: Option<u32>, name: &str| -> Result<u32, String> {
        let v = v.unwrap_or(720);
        if !(64..=2048).contains(&v) {
            return Err(format!("{name}: 64–2048 pixels"));
        }
        Ok(v & !1)
    };
    let width = side(req.width, "width")?;
    let height = side(req.height, "height")?;
    let cam_dist = req.cam_dist.unwrap_or(6.2);
    if !(0.5..=60.0).contains(&cam_dist) {
        return Err("cam_dist: 0.5–60 (the model is 2 tall)".into());
    }
    let pitch = req.pitch.unwrap_or(8.0);
    if !(-60.0..=80.0).contains(&pitch) {
        return Err("pitch: -60–80 degrees".into());
    }
    let mut keyframes = req.keyframes.clone().unwrap_or_else(|| vec![1]);
    keyframes.sort_unstable();
    keyframes.dedup();
    if keyframes.is_empty() || keyframes.len() > 12 {
        return Err("keyframes: 1–12 frame numbers".into());
    }
    if let Some(k) = keyframes.iter().find(|k| **k < 1 || **k > frames) {
        return Err(format!("keyframe {k} is outside frames 1–{frames}"));
    }
    Ok(json!({
        "model": model.to_string_lossy(),
        "out": out.to_string_lossy(),
        "mode": mode,
        "frames": frames,
        "width": width,
        "height": height,
        "cam_dist": cam_dist,
        // A walk reads best three-quarter on.
        "yaw": req.yaw.unwrap_or(if mode == "walk" { -30.0 } else { 0.0 }),
        "pitch": pitch,
        "keyframes": keyframes,
        "video": mode != "still" && frames > 1,
    }))
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Where Blender may be, in the order they are tried. Pure, for tests.
pub fn candidates(
    configured: Option<&str>,
    env: Option<OsString>,
    path_var: Option<OsString>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        out.push(PathBuf::from(c));
    }
    if let Some(e) = env.filter(|e| !e.is_empty()) {
        out.push(PathBuf::from(e));
    }
    if let Some(p) = path_var {
        out.extend(std::env::split_paths(&p).map(|d| d.join(exe("blender"))));
    }
    if cfg!(target_os = "macos") {
        out.push("/Applications/Blender.app/Contents/MacOS/Blender".into());
        if let Some(h) = home {
            out.push(h.join("Applications/Blender.app/Contents/MacOS/Blender"));
        }
    } else if cfg!(windows) {
        // `Blender Foundation\Blender 5.2\blender.exe` — newest first.
        for base in ["C:\\Program Files\\Blender Foundation", "C:\\Program Files (x86)\\Blender Foundation"] {
            let Ok(read) = std::fs::read_dir(base) else { continue };
            let mut dirs: Vec<PathBuf> = read.flatten().map(|d| d.path()).collect();
            dirs.sort();
            out.extend(dirs.into_iter().rev().map(|d| d.join("blender.exe")));
        }
    } else {
        for p in [
            "/snap/bin/blender",
            "/usr/bin/blender",
            "/usr/local/bin/blender",
            "/opt/blender/blender",
            "/var/lib/flatpak/exports/bin/org.blender.Blender",
        ] {
            out.push(p.into());
        }
        if let Some(h) = home {
            out.push(h.join(".local/share/flatpak/exports/bin/org.blender.Blender"));
        }
    }
    out
}

/// The `render.blender` field of a manifest, when set.
fn configured(manifest: Option<&crate::commands::content_project::ContentProjectManifest>) -> Option<String> {
    manifest?
        .extra
        .get("render")?
        .get("blender")?
        .as_str()
        .map(str::to_string)
}

/// The first Blender that exists, or `None`.
pub fn find_blender(configured: Option<&str>) -> Option<PathBuf> {
    candidates(
        configured,
        std::env::var_os("BLENDER"),
        std::env::var_os("PATH"),
        dirs::home_dir().as_deref(),
    )
    .into_iter()
    .find(|p| p.is_file())
}

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Copy one render output under `<assets>/` and register it.
async fn place(root: &Path, dir: &Path, from: &Path, rel: String, id: String, source: Value) -> Result<Value, String> {
    if let Err(e) = tokio::fs::copy(from, dir.join(&rel)).await {
        return Err(format!("Could not copy the render into assets/{rel}: {e}"));
    }
    let res = studio_assets::import(
        root,
        studio_assets::ImportRequest {
            file: Some(rel),
            id: Some(id),
            source: Some(source),
            ..Default::default()
        },
    )
    .await;
    if res["ok"] == true {
        Ok(res["asset"].clone())
    } else {
        Err(res["note"].as_str().unwrap_or("register failed").to_string())
    }
}

/// Blender, the script and a job, run headless; the parsed `result.json`
/// and where the outputs are. `Err` is a readable tool outcome.
struct Run {
    result: Value,
    blender: PathBuf,
    out: PathBuf,
    _work: tempfile::TempDir,
}

async fn run_blender(
    manifest: Option<&crate::commands::content_project::ContentProjectManifest>,
    make_job: impl FnOnce(&Path) -> Result<Value, String>,
) -> Result<Run, Value> {
    let configured = configured(manifest);
    let Some(blender) = find_blender(configured.as_deref()) else {
        return Err(fail(
            "Blender was not found on this computer. Install it from https://www.blender.org/download/ \
             (the Studio looks in the standard place for your system), or put its path in \
             codeg-project.json as `\"render\": { \"blender\": \"/path/to/blender\" }`.",
        ));
    };
    let work = tempfile::tempdir().map_err(|e| fail(format!("Could not make a temporary folder: {e}")))?;
    let out = work.path().join("out");
    let script = work.path().join("studio_render.py");
    let job_path = work.path().join("job.json");
    let job = make_job(&out).map_err(fail)?;
    tokio::fs::write(&script, SCRIPT)
        .await
        .map_err(|e| fail(format!("Could not write the render script: {e}")))?;
    tokio::fs::write(&job_path, job.to_string())
        .await
        .map_err(|e| fail(format!("Could not write the render job: {e}")))?;
    let mut cmd = crate::process::tokio_command(&blender);
    cmd.arg("-b")
        .arg("--factory-startup")
        .arg("-P")
        .arg(&script)
        .arg("--")
        .arg(&job_path)
        .kill_on_drop(true);
    let output = match tokio::time::timeout(TIMEOUT, cmd.output()).await {
        Err(_) => return Err(fail("Blender did not finish within 30 minutes and was stopped.")),
        Ok(Err(e)) => return Err(fail(format!("Could not start {}: {e}", blender.display()))),
        Ok(Ok(o)) => o,
    };
    let result: Value = tokio::fs::read(out.join("result.json"))
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    if result["ok"] != true {
        let log = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let why = result["note"].as_str().map(str::to_string).unwrap_or_else(|| tail(&log, 12));
        return Err(fail(format!("Blender ({}) did not finish the render.\n{why}", blender.display())));
    }
    Ok(Run { result, blender, out, _work: work })
}

/// Register a run's clip and stills under one free id stem; `source(frame)`
/// is each one's provenance. The tool outcome.
async fn register_run(root: &Path, dir: &Path, register: &Value, run: &Run, base: &str, source: impl Fn(Option<u64>) -> Value) -> Value {
    let stills: Vec<(u64, String)> = run.result["keyframes"]
        .as_array()
        .map(|ks| {
            ks.iter()
                .filter_map(|k| Some((k["frame"].as_u64()?, k["file"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let video = run.result["video"].as_str().map(str::to_string);
    // One id stem for the set, free in the register and on disk.
    let stem = (1..)
        .map(|n| if n == 1 { base.to_string() } else { format!("{base}-{n}") })
        .find(|s| {
            let video_free = video.is_none()
                || (!dir.join(format!("{RENDER_DIR}/{s}.mp4")).exists()
                    && studio_assets::find(register, s).is_none());
            let stills_free = stills.iter().all(|(f, _)| {
                let id = format!("{s}-f{f:03}");
                !dir.join(format!("{RENDER_DIR}/{id}.png")).exists()
                    && studio_assets::find(register, &id).is_none()
            });
            video_free && stills_free
        })
        .expect("an unbounded range finds a free stem");
    if let Err(e) = tokio::fs::create_dir_all(dir.join(RENDER_DIR)).await {
        return fail(format!("Could not create assets/{RENDER_DIR}: {e}"));
    }
    let mut made = Vec::new();
    let mut video_entry = Value::Null;
    if let Some(v) = &video {
        let rel = format!("{RENDER_DIR}/{stem}.mp4");
        match place(root, dir, &run.out.join(v), rel, stem.clone(), source(None)).await {
            Ok(e) => video_entry = e,
            Err(note) => return fail(note),
        }
    }
    for (frame, f) in &stills {
        let id = format!("{stem}-f{frame:03}");
        let rel = format!("{RENDER_DIR}/{id}.png");
        match place(root, dir, &run.out.join(f), rel, id, source(Some(*frame))).await {
            Ok(e) => made.push(e),
            Err(note) => return fail(note),
        }
    }
    json!({
        "ok": true,
        "video": video_entry,
        "keyframes": made,
        "blender": run.blender.to_string_lossy(),
        "blender_version": run.result["blender"],
        "seconds": run.result["seconds"],
        "warnings": run.result.get("warnings").cloned().unwrap_or(json!([])),
        "note": "Registered in assets/manifest.json. A still can be the first frame of a generated video (studio_generate_asset kind video, from the still).",
    })
}

/// Render `req.from` and register the clip and stills.
pub async fn render(root: &Path, req: RenderRequest) -> Value {
    let manifest = match studio_assets::project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let dir = studio_assets::assets_dir(root, manifest.as_ref());
    let register = match studio_assets::read_register(&dir).await {
        Ok(r) => r,
        Err(note) => return fail(note),
    };
    let Some(entry) = studio_assets::find(&register, &req.from) else {
        return fail(format!("No material `{}`. Call studio_list_assets for the ids.", req.from));
    };
    let file = entry["file"].as_str().unwrap_or("").to_string();
    if studio_assets::kind_of(&file) != "model" {
        return fail(format!("`{}` is not a 3D model; render takes a GLB material.", req.from));
    }
    if req.mode.as_deref() == Some("walk") && entry.get("bones").is_none() {
        return fail(format!(
            "`{}` has no skeleton. Rig it first (studio_generate_asset kind rig, from `{}`), then walk the rigged model.",
            req.from, req.from
        ));
    }
    let model = dir.join(&file);
    if !model.is_file() {
        return fail(format!("assets/{file} is missing on disk."));
    }
    if let Some(id) = req.id.as_deref() {
        if !crate::studio_scene::is_id(id) {
            return fail("id: letters, digits, - and _ (max 100)");
        }
    }
    let mut job_seen = Value::Null;
    let run = match run_blender(manifest.as_ref(), |out| {
        let j = job(&req, &model, out)?;
        job_seen = j.clone();
        Ok(j)
    })
    .await
    {
        Ok(r) => r,
        Err(outcome) => return outcome,
    };
    let job = job_seen;
    let mode = job["mode"].as_str().unwrap_or("turntable").to_string();
    let base = req.id.clone().unwrap_or_else(|| format!("{}-{mode}", req.from));
    let params = json!({
        "mode": mode,
        "frames": job["frames"],
        "width": job["width"],
        "height": job["height"],
        "cam_dist": job["cam_dist"],
        "yaw": job["yaw"],
        "pitch": job["pitch"],
    });
    let source = |frame: Option<u64>| {
        let mut s = json!({
            "kind": "render",
            "from": req.from,
            "workflow": format!("blender-{mode}"),
            "params": params,
            "blender": run.result["blender"],
            "engine": run.result["engine"],
            "seconds": run.result["seconds"],
        });
        if let Some(f) = frame {
            s["frame"] = json!(f);
        }
        s
    };
    register_run(root, &dir, &register, &run, &base, source).await
}

/// What `render_set` is asked to film: one camera of a set over a time span.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct SetRenderRequest {
    pub set: String,
    pub camera: String,
    /// Start, seconds. Default 0.
    #[serde(default)]
    pub from: Option<f64>,
    /// End, seconds. Default the set's `duration`. `from == to` → one still.
    #[serde(default)]
    pub to: Option<f64>,
    /// Output size; default the set's `frame`.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Times (seconds) saved as stills. Default the start.
    #[serde(default)]
    pub stills: Option<Vec<f64>>,
    /// Id for the new materials (stills get `-fNNN`). Default `<set>-<camera>`.
    #[serde(default)]
    pub id: Option<String>,
}

/// The job for a set render: the normalized set with each model's absolute
/// path, the span in frames, the stills as frame numbers. Pure, for tests.
pub fn set_job(set: &Value, req: &SetRenderRequest, models: &std::collections::HashMap<String, PathBuf>, out: &Path) -> Result<Value, String> {
    let cameras = set["cameras"].as_array().cloned().unwrap_or_default();
    if !cameras.iter().any(|c| c["id"] == req.camera.as_str()) {
        let ids: Vec<&str> = cameras.iter().filter_map(|c| c["id"].as_str()).collect();
        return Err(format!("camera `{}` is not in the set (cameras: {})", req.camera, ids.join(", ")));
    }
    let fps = set["fps"].as_f64().unwrap_or(24.0);
    let duration = set["duration"].as_f64().unwrap_or(15.0);
    let from = req.from.unwrap_or(0.0);
    let to = req.to.unwrap_or(duration);
    if !(0.0..=duration).contains(&from) || !(from..=duration).contains(&to) {
        return Err(format!("from/to: 0 ≤ from ≤ to ≤ {duration} (the set's duration)"));
    }
    let frames = (((to - from) * fps).round() as u32).max(1);
    if frames > 1440 {
        return Err(format!("{frames} frames is too long: up to 1440 (60 s at 24 fps) per render"));
    }
    let side = |v: Option<u32>, d: &Value, name: &str| -> Result<u32, String> {
        let v = v.unwrap_or(d.as_u64().unwrap_or(720) as u32);
        if !(64..=4096).contains(&v) {
            return Err(format!("{name}: 64–4096 pixels"));
        }
        Ok(v & !1)
    };
    let width = side(req.width, &set["frame"]["width"], "width")?;
    let height = side(req.height, &set["frame"]["height"], "height")?;
    let stills = req.stills.clone().unwrap_or_else(|| vec![from]);
    if stills.is_empty() || stills.len() > 24 {
        return Err("stills: 1–24 times".into());
    }
    if stills.iter().any(|s| !s.is_finite() || *s < from - 1e-6 || *s > to + 1e-6) {
        return Err(format!("stills: times between from ({from}) and to ({to})"));
    }
    // A still at `to` is the clip's last frame.
    let mut keyframes: Vec<u32> = stills
        .iter()
        .map(|s| ((((s - from) * fps).round() as u32) + 1).min(frames))
        .collect();
    keyframes.sort_unstable();
    keyframes.dedup();
    let mut scene = set.clone();
    for list in ["props", "actors"] {
        for item in scene[list].as_array_mut().into_iter().flatten() {
            if let Some(path) = item["asset"].as_str().and_then(|a| models.get(a)) {
                item["model"] = json!(path.to_string_lossy());
            }
        }
    }
    Ok(json!({
        "mode": "set",
        "out": out.to_string_lossy(),
        "set": scene,
        "camera": req.camera,
        "fps": fps,
        "start": from,
        "frames": frames,
        "width": width,
        "height": height,
        "keyframes": keyframes,
        "video": frames > 1,
    }))
}

/// Film `req.camera` of a set (already read and normalized) and register the
/// clip and stills.
pub async fn render_set(root: &Path, set: &Value, req: SetRenderRequest) -> Value {
    let manifest = match studio_assets::project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let dir = studio_assets::assets_dir(root, manifest.as_ref());
    let register = match studio_assets::read_register(&dir).await {
        Ok(r) => r,
        Err(note) => return fail(note),
    };
    if let Some(id) = req.id.as_deref() {
        if !crate::studio_scene::is_id(id) {
            return fail("id: letters, digits, - and _ (max 100)");
        }
    }
    let mut models = std::collections::HashMap::new();
    for list in ["props", "actors"] {
        for item in set[list].as_array().into_iter().flatten() {
            let asset = item["asset"].as_str().unwrap_or("");
            if let Some(e) = studio_assets::find(&register, asset) {
                let f = e["file"].as_str().unwrap_or("");
                if studio_assets::kind_of(f) == "model" && dir.join(f).is_file() {
                    models.insert(asset.to_string(), dir.join(f));
                }
            }
        }
    }
    let mut job_seen = Value::Null;
    let run = match run_blender(manifest.as_ref(), |out| {
        let j = set_job(set, &req, &models, out)?;
        job_seen = j.clone();
        Ok(j)
    })
    .await
    {
        Ok(r) => r,
        Err(outcome) => return outcome,
    };
    let set_id = set["id"].as_str().unwrap_or("set");
    let base = req.id.clone().unwrap_or_else(|| format!("{set_id}-{}", req.camera));
    let params = json!({
        "set": set_id,
        "camera": req.camera,
        "from": job_seen["start"],
        "frames": job_seen["frames"],
        "fps": job_seen["fps"],
        "width": job_seen["width"],
        "height": job_seen["height"],
    });
    let source = |frame: Option<u64>| {
        let mut s = json!({
            "kind": "render",
            "from": format!("set:{set_id}"),
            "workflow": "blender-set",
            "params": params,
            "blender": run.result["blender"],
            "engine": run.result["engine"],
            "seconds": run.result["seconds"],
        });
        if let Some(f) = frame {
            s["frame"] = json!(f);
            s["t"] = crate::studio_set::num(job_seen["start"].as_f64().unwrap_or(0.0) + (f as f64 - 1.0) / job_seen["fps"].as_f64().unwrap_or(24.0));
        }
        s
    };
    register_run(root, &dir, &register, &run, &base, source).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_fills_defaults_and_refuses_out_of_range() {
        let req = RenderRequest { from: "cup-3d".into(), ..Default::default() };
        let j = job(&req, Path::new("/m.glb"), Path::new("/o")).unwrap();
        assert_eq!(j["mode"], "turntable");
        assert_eq!(j["frames"], 72);
        assert_eq!(j["width"], 720);
        assert_eq!(j["keyframes"], json!([1]));
        assert_eq!(j["video"], true);

        let walk = RenderRequest { mode: Some("walk".into()), ..req.clone() };
        let j = job(&walk, Path::new("/m.glb"), Path::new("/o")).unwrap();
        assert_eq!((j["frames"].as_u64(), j["yaw"].as_f64(), j["video"].as_bool()), (Some(48), Some(-30.0), Some(true)));

        let still = RenderRequest { mode: Some("still".into()), frames: Some(99), ..req.clone() };
        let j = job(&still, Path::new("/m.glb"), Path::new("/o")).unwrap();
        assert_eq!(j["frames"], 1);
        assert_eq!(j["video"], false);

        let odd = RenderRequest { width: Some(721), ..req.clone() };
        assert_eq!(job(&odd, Path::new("/m"), Path::new("/o")).unwrap()["width"], 720);
        for bad in [
            RenderRequest { mode: Some("orbit".into()), ..req.clone() },
            RenderRequest { frames: Some(0), ..req.clone() },
            RenderRequest { width: Some(10_000), ..req.clone() },
            RenderRequest { keyframes: Some(vec![80]), ..req.clone() },
            RenderRequest { cam_dist: Some(0.0), ..req.clone() },
        ] {
            assert!(job(&bad, Path::new("/m"), Path::new("/o")).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn blender_is_looked_for_in_order() {
        let path = std::env::join_paths(["/a", "/b"]).unwrap();
        let c = candidates(Some("/mine/blender"), Some("/env/blender".into()), Some(path), Some(Path::new("/home/u")));
        assert_eq!(c[0], PathBuf::from("/mine/blender"));
        assert_eq!(c[1], PathBuf::from("/env/blender"));
        assert_eq!(c[2], Path::new("/a").join(exe("blender")));
        assert_eq!(c[3], Path::new("/b").join(exe("blender")));
        if cfg!(target_os = "macos") {
            assert!(c.contains(&PathBuf::from("/Applications/Blender.app/Contents/MacOS/Blender")));
        } else if cfg!(target_os = "linux") {
            assert!(c.contains(&PathBuf::from("/snap/bin/blender")));
        }
        assert!(candidates(Some("  "), None, None, None).iter().all(|p| p != Path::new("")));
    }

    #[test]
    fn script_reads_the_job_it_is_given() {
        for key in ["model", "out", "mode", "frames", "width", "height", "cam_dist", "yaw", "pitch", "keyframes", "video"] {
            assert!(SCRIPT.contains(&format!("\"{key}\"")), "script ignores {key}");
        }
        assert!(SCRIPT.contains("result.json"));
    }

    #[test]
    fn set_job_turns_seconds_into_frames() {
        let set = crate::studio_set::parse_set(&crate::studio_set::starter("cafe", None)).unwrap();
        let mut set = set;
        set["props"] = json!([{ "id": "cup", "asset": "cup", "position": [0, 0, 0], "rotation": [0, 0, 0] }]);
        let models = std::collections::HashMap::from([("cup".to_string(), PathBuf::from("/a/cup.glb"))]);
        let req = SetRenderRequest { set: "cafe".into(), camera: "cam_a".into(), ..Default::default() };
        let j = set_job(&set, &req, &models, Path::new("/o")).unwrap();
        assert_eq!((j["frames"].as_u64(), j["width"].as_u64(), j["height"].as_u64()), (Some(360), Some(720), Some(1280)));
        assert_eq!(j["keyframes"], json!([1]));
        assert_eq!(j["video"], true);
        assert_eq!(j["set"]["props"][0]["model"], "/a/cup.glb");
        let span = SetRenderRequest { from: Some(2.0), to: Some(4.0), stills: Some(vec![2.0, 3.0, 4.0]), ..req.clone() };
        let j = set_job(&set, &span, &models, Path::new("/o")).unwrap();
        assert_eq!(j["frames"], 48);
        assert_eq!(j["keyframes"], json!([1, 25, 48]), "a still at `to` is the last frame");
        let still = SetRenderRequest { from: Some(1.0), to: Some(1.0), ..req.clone() };
        assert_eq!(set_job(&set, &still, &models, Path::new("/o")).unwrap()["video"], false);
        for (bad, needle) in [
            (SetRenderRequest { camera: "cam_z".into(), ..req.clone() }, "cameras: cam_a"),
            (SetRenderRequest { to: Some(99.0), ..req.clone() }, "duration"),
            (SetRenderRequest { from: Some(3.0), to: Some(2.0), ..req.clone() }, "from"),
            (SetRenderRequest { stills: Some(vec![20.0]), ..req.clone() }, "stills"),
            (SetRenderRequest { width: Some(10), ..req.clone() }, "width"),
        ] {
            let err = set_job(&set, &bad, &models, Path::new("/o")).unwrap_err();
            assert!(err.contains(needle), "{err} ∌ {needle}");
        }
        for key in ["\"set\"", "\"camera\"", "\"start\"", "\"fps\"", "\"keys\"", "\"ease\"", "\"motion\"", "\"model\""] {
            assert!(SCRIPT.contains(key), "script ignores {key}");
        }
    }

    async fn project_with_model() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        tokio::fs::create_dir_all(root.join("assets/props")).await.unwrap();
        tokio::fs::write(root.join("assets/props/cup.glb"), b"glTF").await.unwrap();
        tokio::fs::write(root.join("assets/hero.png"), b"x").await.unwrap();
        tokio::fs::write(
            root.join("assets/manifest.json"),
            r#"{"schema":1,"assets":[{"id":"cup","file":"props/cup.glb"},{"id":"hero","file":"hero.png"}]}"#,
        )
        .await
        .unwrap();
        (tmp, root)
    }

    #[tokio::test]
    async fn refusals_are_readable() {
        let (_tmp, root) = project_with_model().await;
        let r = render(&root, RenderRequest { from: "ghost".into(), ..Default::default() }).await;
        assert_eq!(r["ok"], false);
        assert!(r["note"].as_str().unwrap().contains("studio_list_assets"));
        let r = render(&root, RenderRequest { from: "hero".into(), ..Default::default() }).await;
        assert!(r["note"].as_str().unwrap().contains("not a 3D model"));
        let r = render(&root, RenderRequest { from: "cup".into(), mode: Some("walk".into()), ..Default::default() }).await;
        assert!(r["note"].as_str().unwrap().contains("Rig it first"));
    }

    /// A fake Blender (a shell script) that writes what the real one would:
    /// the whole register path runs without Blender installed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_becomes_materials() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, root) = project_with_model().await;
        let fake = root.join("fake-blender");
        let png = {
            let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]));
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
            buf.into_inner()
        };
        tokio::fs::write(root.join("key.png"), &png).await.unwrap();
        // job.json is the last argument; read `out` from it with sed.
        let sh = format!(
            "#!/bin/sh\nfor a; do job=$a; done\nout=$(sed -E 's/.*\"out\":\"([^\"]+)\".*/\\1/' \"$job\")\nmkdir -p \"$out\"\ncp '{key}' \"$out/key_001.png\"\nprintf 'mp4' > \"$out/video.mp4\"\nprintf '{{\"ok\":true,\"blender\":\"5.2.2\",\"engine\":\"BLENDER_EEVEE\",\"keyframes\":[{{\"frame\":1,\"file\":\"key_001.png\"}}],\"video\":\"video.mp4\",\"seconds\":1.5}}' > \"$out/result.json\"\n",
            key = root.join("key.png").display()
        );
        tokio::fs::write(&fake, sh).await.unwrap();
        tokio::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).await.unwrap();
        tokio::fs::write(
            root.join("codeg-project.json"),
            serde_json::to_string(&json!({
                "schema": 1, "name": "p", "created_at": "", "template": "blank", "outputs": [],
                "render": { "blender": fake.to_string_lossy() }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let r = render(&root, RenderRequest { from: "cup".into(), ..Default::default() }).await;
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["video"]["id"], "cup-turntable");
        assert_eq!(r["video"]["kind"], "video");
        assert_eq!(r["video"]["file"], "generated/renders/cup-turntable.mp4");
        assert_eq!(r["video"]["source"]["from"], "cup");
        assert_eq!(r["video"]["source"]["blender"], "5.2.2");
        assert_eq!(r["keyframes"][0]["id"], "cup-turntable-f001");
        assert_eq!(r["keyframes"][0]["width"], 4);
        assert_eq!(r["keyframes"][0]["source"]["frame"], 1);

        // A film set through the same Blender: `<set>-<camera>`, provenance
        // names the set and the time of each still.
        let set = crate::studio_set::parse_set(&crate::studio_set::starter("cafe", None)).unwrap();
        let r = render_set(
            &root,
            &set,
            SetRenderRequest { set: "cafe".into(), camera: "cam_a".into(), from: Some(2.0), to: Some(4.0), stills: Some(vec![2.0]), ..Default::default() },
        )
        .await;
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["video"]["id"], "cafe-cam_a");
        assert_eq!(r["video"]["source"]["from"], "set:cafe");
        assert_eq!(r["video"]["source"]["workflow"], "blender-set");
        assert_eq!(r["keyframes"][0]["source"]["t"], 2);
        assert_eq!(render_set(&root, &set, SetRenderRequest { set: "cafe".into(), camera: "nope".into(), ..Default::default() }).await["ok"], false);

        // Again: a fresh stem, nothing overwritten.
        let r = render(&root, RenderRequest { from: "cup".into(), ..Default::default() }).await;
        assert_eq!(r["video"]["id"], "cup-turntable-2");
        assert_eq!(r["keyframes"][0]["id"], "cup-turntable-2-f001");
    }
}
