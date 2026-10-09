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
    /// `turntable` (camera circles once, video + stills) or `still`.
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
    if mode != "turntable" && mode != "still" {
        return Err("mode: `turntable` or `still`".into());
    }
    let frames = if mode == "still" { 1 } else { req.frames.unwrap_or(72) };
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
        "yaw": req.yaw.unwrap_or(0.0),
        "pitch": pitch,
        "keyframes": keyframes,
        "video": mode == "turntable" && frames > 1,
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
    let model = dir.join(&file);
    if !model.is_file() {
        return fail(format!("assets/{file} is missing on disk."));
    }
    if let Some(id) = req.id.as_deref() {
        if !crate::studio_scene::is_id(id) {
            return fail("id: letters, digits, - and _ (max 100)");
        }
    }
    let configured = configured(manifest.as_ref());
    let Some(blender) = find_blender(configured.as_deref()) else {
        return fail(
            "Blender was not found on this computer. Install it from https://www.blender.org/download/ \
             (the Studio looks in the standard place for your system), or put its path in \
             codeg-project.json as `\"render\": { \"blender\": \"/path/to/blender\" }`.",
        );
    };
    let work = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => return fail(format!("Could not make a temporary folder: {e}")),
    };
    let out = work.path().join("out");
    let script = work.path().join("studio_render.py");
    let job_path = work.path().join("job.json");
    let job = match job(&req, &model, &out) {
        Ok(j) => j,
        Err(note) => return fail(note),
    };
    if let Err(e) = tokio::fs::write(&script, SCRIPT).await {
        return fail(format!("Could not write the render script: {e}"));
    }
    if let Err(e) = tokio::fs::write(&job_path, job.to_string()).await {
        return fail(format!("Could not write the render job: {e}"));
    }
    let mut cmd = crate::process::tokio_command(&blender);
    cmd.arg("-b")
        .arg("--factory-startup")
        .arg("-P")
        .arg(&script)
        .arg("--")
        .arg(&job_path)
        .kill_on_drop(true);
    let output = match tokio::time::timeout(TIMEOUT, cmd.output()).await {
        Err(_) => return fail("Blender did not finish within 30 minutes and was stopped."),
        Ok(Err(e)) => return fail(format!("Could not start {}: {e}", blender.display())),
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
        return fail(format!("Blender ({}) did not finish the render.\n{why}", blender.display()));
    }

    let mode = job["mode"].as_str().unwrap_or("turntable").to_string();
    let base = req.id.clone().unwrap_or_else(|| format!("{}-{mode}", req.from));
    let stills: Vec<(u64, String)> = result["keyframes"]
        .as_array()
        .map(|ks| {
            ks.iter()
                .filter_map(|k| Some((k["frame"].as_u64()?, k["file"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let video = result["video"].as_str().map(str::to_string);
    // One id stem for the set, free in the register and on disk.
    let stem = (1..)
        .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
        .find(|s| {
            let video_free = video.is_none()
                || (!dir.join(format!("{RENDER_DIR}/{s}.mp4")).exists()
                    && studio_assets::find(&register, s).is_none());
            let stills_free = stills.iter().all(|(f, _)| {
                let id = format!("{s}-f{f:03}");
                !dir.join(format!("{RENDER_DIR}/{id}.png")).exists()
                    && studio_assets::find(&register, &id).is_none()
            });
            video_free && stills_free
        })
        .expect("an unbounded range finds a free stem");
    if let Err(e) = tokio::fs::create_dir_all(dir.join(RENDER_DIR)).await {
        return fail(format!("Could not create assets/{RENDER_DIR}: {e}"));
    }
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
            "blender": result["blender"],
            "engine": result["engine"],
            "seconds": result["seconds"],
        });
        if let Some(f) = frame {
            s["frame"] = json!(f);
        }
        s
    };
    let mut made = Vec::new();
    let mut video_entry = Value::Null;
    if let Some(v) = &video {
        let rel = format!("{RENDER_DIR}/{stem}.mp4");
        match place(root, &dir, &out.join(v), rel, stem.clone(), source(None)).await {
            Ok(e) => video_entry = e,
            Err(note) => return fail(note),
        }
    }
    for (frame, f) in &stills {
        let id = format!("{stem}-f{frame:03}");
        let rel = format!("{RENDER_DIR}/{id}.png");
        match place(root, &dir, &out.join(f), rel, id, source(Some(*frame))).await {
            Ok(e) => made.push(e),
            Err(note) => return fail(note),
        }
    }
    json!({
        "ok": true,
        "video": video_entry,
        "keyframes": made,
        "blender": blender.to_string_lossy(),
        "blender_version": result["blender"],
        "seconds": result["seconds"],
        "note": "Registered in assets/manifest.json. A still can be the first frame of a generated video (studio_generate_asset kind video, from the still).",
    })
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

        // Again: a fresh stem, nothing overwritten.
        let r = render(&root, RenderRequest { from: "cup".into(), ..Default::default() }).await;
        assert_eq!(r["video"]["id"], "cup-turntable-2");
        assert_eq!(r["keyframes"][0]["id"], "cup-turntable-2-f001");
    }
}
