//! Materials of a content project: the files under `<assets>/` and their
//! register `<assets>/manifest.json`, plus the round trip to a generator.
//!
//! Three verbs, shared by the editor's material panel and the companion's
//! `studio_*` MCP tools (both go through [`crate::studio_tools::run`]):
//!
//! - **list** — the register, each entry with whether its file is on disk.
//! - **import** — fetch a URL (or `data:` URL) into `<assets>/`, register it
//!   with where it came from (`source`). When the URL is an output of the
//!   project's generator, the generator's copy is deleted afterwards: the
//!   project keeps the material, the generator is not storage.
//! - **generate** — call the generator named in `codeg-project.json`
//!   (`generate.url`) for an image or a 3D model, optionally feeding an
//!   existing material back in as `source_image`, then import the result
//!   with its provenance (workflow · prompt · seed · `from` material id).
//!
//! The generator is only *called* — nothing here tells it what the result is
//! for. Its API is the genai shape (`/api/images/generate`,
//! `/api/3d/generate`, `/api/outputs`); a different service can answer the
//! same three routes.
//!
//! The register is edited as JSON values so fields this module does not know
//! (game-asset-contract's `role`, `sheet`, …) survive every write.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::commands::content_project as cp;
use crate::studio_presets;
use crate::studio_scene;

/// Largest file `import` accepts. A GLB at texture 4096 is ~30MB.
const MAX_BYTES: usize = 200 * 1024 * 1024;
const MANIFEST: &str = "manifest.json";
/// The image workflow `generate` uses when none is given: a transparent PNG,
/// the shape a 3D lift wants as its input.
const DEFAULT_IMAGE_WORKFLOW: &str = "qwen-image-21-rgba";
const DEFAULT_3D_WORKFLOW: &str = "trellis2";
const DEFAULT_EDIT_WORKFLOW: &str = "qwen-image-21-edit";
/// Keyframe → clip, ~90 s for 768² · 4–5 s. (The turbo variant measured
/// ~60 s on 2026-10-07 but answers 500 at once since 10-09 — issue 1009-8.)
const DEFAULT_VIDEO_WORKFLOW: &str = "minimax-h3-i2v";
/// The redraw that puts a character in a T-pose before the 3D lift — a
/// T-pose rigs far more reliably (model-pick 2026-10-08: 5/6 vs 1/6 natural).
pub const TPOSE_PROMPT: &str = "the same character in a T-pose, arms straight out horizontally, legs apart, front view, same outfit and colours, plain background";

/// Qwen-Image RGBA draws an alpha channel only when the prompt says so — a
/// bare subject comes back opaque (alpha 253–255, 2026-10-08). genai's own
/// recipe wraps the subject in these two sentences.
const RGBA_LEAD: &str = "This is an RGBA format image with transparency.";
const RGBA_TAIL: &str = "The image has an alpha channel and a transparent background.";

/// Who can draw an `image` — the generator's (genai's) `ImageProvider`.
pub const IMAGE_PROVIDERS: &[&str] = &["comfyui", "codex", "openrouter", "openai"];

/// A picture model offered next to the generator's own workflows. genai's
/// catalog carries no per-picture price or time for these, so the measured
/// figures live here (and in the tool description).
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct CloudImage {
    pub provider: &'static str,
    /// Sent as `model`; `None` → the provider's only model.
    pub model: Option<&'static str>,
    pub label: &'static str,
    /// `subscription` (counts against a plan, no per-picture charge) ·
    /// `metered` (charged per picture).
    pub billing: &'static str,
    /// Measured wall time per picture.
    pub seconds: Option<u32>,
    /// Measured price per 1024² picture, USD.
    pub usd: Option<f64>,
    pub note: &'static str,
}

pub const CLOUD_IMAGES: &[CloudImage] = &[
    CloudImage {
        provider: "codex",
        model: None,
        label: "gpt-image-2 (Codex)",
        billing: "subscription",
        seconds: Some(120),
        usd: None,
        note: "The generator owner's ChatGPT subscription through Codex CLI — one picture at a time, ~1.7% of the 5-hour window each (2026-09-27).",
    },
    CloudImage {
        provider: "openrouter",
        model: Some("google/gemini-nano-banana-2.1"),
        label: "Nano Banana 2.1",
        billing: "metered",
        seconds: Some(11),
        usd: Some(0.034),
        note: "Google, via OpenRouter — 1024² in ~11 s (2026-10-09).",
    },
    CloudImage {
        provider: "openrouter",
        model: Some("google/gemini-3-pro-image"),
        label: "Nano Banana Pro",
        billing: "metered",
        seconds: None,
        usd: None,
        note: "Google, via OpenRouter — the larger sibling; not measured yet.",
    },
];

/// The prompt as an RGBA workflow wants it; other workflows get it as is.
pub fn shaped_prompt(workflow: &str, prompt: &str) -> String {
    if !workflow.contains("rgba") || prompt.contains("RGBA format") {
        return prompt.to_string();
    }
    let subject = prompt.trim_end_matches('.');
    format!("{RGBA_LEAD} {subject}. {RGBA_TAIL}")
}

/// What `import` is asked to fetch.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct ImportRequest {
    /// http(s) or base64 `data:` URL to fetch. Empty when `file` is given.
    #[serde(default)]
    pub url: String,
    /// A file already under `<assets>/` to register in place (nothing is
    /// copied) — for files an agent or a person put there by hand.
    #[serde(default)]
    pub file: Option<String>,
    /// Material id (letters, digits, - and _). Derived from the URL's file
    /// name when absent; a taken id gets a `-2`, `-3`… suffix.
    #[serde(default)]
    pub id: Option<String>,
    /// Folder under `<assets>/`. Defaults to `generated/images` or
    /// `generated/models` by the file's kind.
    #[serde(default)]
    pub dir: Option<String>,
    /// Provenance stored on the entry as `source` (workflow, prompt, seed,
    /// from, …). Free-form object.
    #[serde(default)]
    pub source: Option<Value>,
    /// Where it will be used — a preset id (`studio_presets`), kept on the
    /// entry as `use` and judged by `check`.
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_for: Option<String>,
}

/// What `generate` is asked to make.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize, PartialEq)]
pub struct GenerateRequest {
    /// `image` (draw) · `edit` (redraw an image by prompt) · `tpose` (redraw
    /// a character in a T-pose) · `3d` (lift an image) · `rig` (put bones in
    /// a model) · `video` (an image as the first frame of a clip).
    pub kind: String,
    /// An existing material fed in: an image for `edit` · `tpose` · `3d` ·
    /// `video` (optional for `image`), a model for `rig`.
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    /// `image`: who draws it — `comfyui` (the generator's own GPU, picks a
    /// `workflow`; the default) · `codex` (gpt-image-2 on the generator
    /// owner's ChatGPT subscription) · `openrouter` · `openai` (metered,
    /// pick a `model`). See [`CLOUD_IMAGES`] and `studio_generator_options`.
    #[serde(default)]
    pub provider: Option<String>,
    /// Cloud model id for a non-`comfyui` provider, e.g.
    /// `google/gemini-nano-banana-2.1`.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub target_faces: Option<u32>,
    #[serde(default)]
    pub texture_size: Option<u32>,
    /// `3d`: ask the generator to compress the GLB's textures (smaller file).
    #[serde(default)]
    pub compress_textures: Option<bool>,
    /// `video`: clip length in seconds (default 5).
    #[serde(default)]
    pub duration: Option<f64>,
    /// `video`: canvas (default 768 × 768, reshaped to the image's aspect).
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// `edit`: cut the background away (default true — the result usually
    /// goes on to a 3D lift).
    #[serde(default)]
    pub transparent: Option<bool>,
    /// Id for the new material (see [`ImportRequest::id`]).
    #[serde(default)]
    pub id: Option<String>,
    /// Where it will be used — a preset id. For `3d` it fills
    /// `target_faces` / `texture_size` when those are not given.
    #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
    pub use_for: Option<String>,
}

pub(crate) fn assets_dir(root: &Path, manifest: Option<&cp::ContentProjectManifest>) -> PathBuf {
    let rel = manifest
        .map(|m| m.paths.assets.clone())
        .unwrap_or_else(|| "assets".into());
    root.join(rel)
}

pub(crate) async fn project(root: &Path) -> Result<Option<cp::ContentProjectManifest>, String> {
    cp::read_content_project(root.to_string_lossy().to_string())
        .await
        .map_err(|e| e.message)
}

/// The generator's base URL from the manifest, without a trailing slash.
pub fn generator_url(manifest: Option<&cp::ContentProjectManifest>) -> Option<String> {
    manifest
        .and_then(|m| m.generate.as_ref())
        .map(|g| g.url.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

pub(crate) async fn read_register(dir: &Path) -> Result<Value, String> {
    let path = dir.join(MANIFEST);
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => {
            let mut value: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("assets/{MANIFEST} is not valid JSON: {e}"))?;
            let obj = value
                .as_object_mut()
                .ok_or_else(|| format!("assets/{MANIFEST} must be an object"))?;
            match obj.get("assets") {
                None => {
                    obj.insert("assets".into(), json!([]));
                }
                Some(Value::Array(_)) => {}
                Some(_) => return Err(format!("assets/{MANIFEST}: `assets` must be a list")),
            }
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "schema": 1, "assets": [] }))
        }
        Err(e) => Err(format!("Could not read assets/{MANIFEST}: {e}")),
    }
}

/// Pretty JSON with chosen keys first (in that order) and the rest after —
/// `serde_json`'s map is sorted, which would shuffle a hand-kept file on
/// every write. `children` orders the objects of one array field the same way.
pub struct Ordered<'a> {
    pub value: &'a Value,
    pub first: &'a [&'a str],
    pub children: Option<(&'a str, &'a [&'a str])>,
}

impl serde::Serialize for Ordered<'_> {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        struct Items<'a>(&'a [Value], &'a [&'a str]);
        impl serde::Serialize for Items<'_> {
            fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
                let mut seq = ser.serialize_seq(Some(self.0.len()))?;
                for item in self.0 {
                    seq.serialize_element(&Ordered { value: item, first: self.1, children: None })?;
                }
                seq.end()
            }
        }
        let Some(map) = self.value.as_object() else {
            return self.value.serialize(ser);
        };
        let mut out = ser.serialize_map(Some(map.len()))?;
        let keys = self
            .first
            .iter()
            .copied()
            .filter(|k| map.contains_key(*k))
            .chain(map.keys().map(String::as_str).filter(|k| !self.first.contains(k)));
        for key in keys {
            let v = &map[key];
            match (self.children, v.as_array()) {
                (Some((field, order)), Some(items)) if field == key => {
                    out.serialize_entry(key, &Items(items, order))?
                }
                _ => out.serialize_entry(key, v)?,
            }
        }
        out.end()
    }
}

const REGISTER_ORDER: &[&str] = &["schema", "container"];
const ENTRY_ORDER: &[&str] = &[
    "id", "file", "kind", "use", "bytes", "width", "height", "added_at", "source",
];

async fn write_register(dir: &Path, value: &Value) -> Result<(), String> {
    let ordered = Ordered {
        value,
        first: REGISTER_ORDER,
        children: Some(("assets", ENTRY_ORDER)),
    };
    let mut body = serde_json::to_string_pretty(&ordered).map_err(|e| e.to_string())?;
    body.push('\n');
    let path = dir.join(MANIFEST);
    let tmp = dir.join(format!("{MANIFEST}.tmp"));
    tokio::fs::write(&tmp, body)
        .await
        .map_err(|e| format!("Could not write assets/{MANIFEST}: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("Could not write assets/{MANIFEST}: {e}"))
}

fn entries(register: &Value) -> &[Value] {
    register["assets"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub(crate) fn find<'a>(register: &'a Value, id: &str) -> Option<&'a Value> {
    entries(register).iter().find(|e| e["id"] == id)
}

/// `image` · `model` · `video` · `other`, by extension.
pub fn kind_of(file: &str) -> &'static str {
    match ext_of(file).as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" => "image",
        "glb" | "gltf" => "model",
        "mp4" | "webm" | "mov" => "video",
        _ => "other",
    }
}

fn ext_of(file: &str) -> String {
    Path::new(file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "model/gltf-binary" => Some("glb"),
        "model/gltf+json" => Some("gltf"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        _ => None,
    }
}

/// A relative folder under `<assets>/`: no absolute paths, no `..`.
fn safe_dir(dir: &str) -> Result<String, String> {
    let trimmed = dir.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.contains('\\')
        || trimmed
            .split('/')
            .any(|seg| seg.is_empty() || seg == "." || seg == ".." || !studio_scene::is_id(seg))
    {
        return Err(format!(
            "dir `{dir}`: a folder under assets/ made of letters, digits, - and _ segments"
        ));
    }
    Ok(trimmed.to_string())
}

/// `hero_idle_120x180.png` → `hero_idle_120x180`; anything else folded into
/// the id alphabet.
fn id_from_name(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let folded: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(60)
        .collect();
    let folded = folded.trim_matches('-').to_string();
    if folded.is_empty() {
        "material".into()
    } else {
        folded
    }
}

/// First few ascii words of a prompt as an id (`a cute teacup` →
/// `a-cute-teacup`); `image` when nothing ascii is left.
fn id_from_prompt(prompt: &str) -> String {
    let words: Vec<String> = prompt
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(4)
        .map(str::to_ascii_lowercase)
        .collect();
    if words.is_empty() {
        "image".into()
    } else {
        words.join("-")
    }
}

fn unique_id(register: &Value, wanted: &str) -> String {
    if find(register, wanted).is_none() {
        return wanted.to_string();
    }
    (2..)
        .map(|n| format!("{wanted}-{n}"))
        .find(|candidate| find(register, candidate).is_none())
        .expect("an unused suffix exists")
}

/// What a material is made of, read from its bytes: `width`/`height` for an
/// image; for a model `triangles`, `vertices`, `textures` ([w, h] of each
/// embedded image) and `texture_max` (the largest side). Empty when the
/// bytes cannot be read — a material with unknown stats is still a material.
pub fn stats(file: &str, bytes: &[u8]) -> Map<String, Value> {
    let mut out = Map::new();
    match kind_of(file) {
        "image" => {
            if let Some((w, h)) = image_size(bytes) {
                out.insert("width".into(), json!(w));
                out.insert("height".into(), json!(h));
            }
            if let Some(opaque) = is_opaque(bytes) {
                out.insert("opaque".into(), json!(opaque));
            }
        }
        "model" => {
            if let Some(m) = model_stats(bytes) {
                out = m;
            }
        }
        _ => {}
    }
    out
}

/// Whether no pixel is meaningfully transparent (alpha ≥ 250 everywhere).
/// Formats without an alpha channel are opaque by definition.
fn is_opaque(bytes: &[u8]) -> Option<bool> {
    let img = image::load_from_memory(bytes).ok()?;
    if !img.color().has_alpha() {
        return Some(true);
    }
    Some(img.to_rgba8().pixels().all(|p| p.0[3] >= 250))
}

fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

/// glTF 2.0 counts from a `.glb` (JSON + BIN chunks) or a `.gltf` (JSON).
fn model_stats(bytes: &[u8]) -> Option<Map<String, Value>> {
    let u32_at = |at: usize| -> Option<usize> {
        bytes
            .get(at..at + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let (json, bin): (Value, Option<&[u8]>) = if bytes.starts_with(b"glTF") {
        let json_len = u32_at(12)?;
        if bytes.get(16..20)? != b"JSON" {
            return None;
        }
        let json = serde_json::from_slice(bytes.get(20..20 + json_len)?).ok()?;
        let bin_at = 20 + json_len;
        let bin = match (u32_at(bin_at), bytes.get(bin_at + 4..bin_at + 8)) {
            (Some(len), Some(b"BIN\0")) => bytes.get(bin_at + 8..bin_at + 8 + len),
            _ => None,
        };
        (json, bin)
    } else {
        (serde_json::from_slice(bytes).ok()?, None)
    };
    let accessors = json["accessors"].as_array().cloned().unwrap_or_default();
    let count_of = |i: &Value| -> u64 {
        i.as_u64()
            .and_then(|i| accessors.get(i as usize))
            .and_then(|a| a["count"].as_u64())
            .unwrap_or(0)
    };
    let (mut triangles, mut vertices) = (0u64, 0u64);
    for mesh in json["meshes"].as_array().into_iter().flatten() {
        for prim in mesh["primitives"].as_array().into_iter().flatten() {
            let verts = count_of(&prim["attributes"]["POSITION"]);
            vertices += verts;
            let n = if prim["indices"].is_null() { verts } else { count_of(&prim["indices"]) };
            triangles += match prim["mode"].as_u64().unwrap_or(4) {
                4 => n / 3,
                5 | 6 => n.saturating_sub(2),
                _ => 0,
            };
        }
    }
    let mut out = Map::new();
    out.insert("triangles".into(), json!(triangles));
    out.insert("vertices".into(), json!(vertices));
    // A rigged model: its largest skin's joints. Absent on a static mesh.
    let bones = json["skins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["joints"].as_array().map(Vec::len))
        .max();
    if let Some(b) = bones {
        out.insert("bones".into(), json!(b));
    }
    if let Some(a) = json["animations"].as_array().filter(|a| !a.is_empty()) {
        out.insert("animations".into(), json!(a.len()));
    }
    let views = json["bufferViews"].as_array().cloned().unwrap_or_default();
    let mut textures = Vec::new();
    for img in json["images"].as_array().into_iter().flatten() {
        let size = img["bufferView"]
            .as_u64()
            .and_then(|v| views.get(v as usize))
            .and_then(|v| {
                let start = v["byteOffset"].as_u64().unwrap_or(0) as usize;
                let len = v["byteLength"].as_u64()? as usize;
                bin?.get(start..start + len)
            })
            .and_then(image_size);
        if let Some((w, h)) = size {
            textures.push(json!([w, h]));
        }
    }
    let max = textures
        .iter()
        .filter_map(|t| Some(t[0].as_u64()?.max(t[1].as_u64()?)))
        .max();
    out.insert("textures".into(), Value::Array(textures));
    if let Some(m) = max {
        out.insert("texture_max".into(), json!(m));
    }
    Some(out)
}

/// Image and model files under `<assets>/` that no register entry names.
async fn unregistered(dir: &Path, register: &Value) -> Vec<String> {
    let known: std::collections::HashSet<String> = entries(register)
        .iter()
        .filter_map(|e| e["file"].as_str().map(str::to_string))
        .collect();
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&d) else { continue };
            for item in read.flatten() {
                let path = item.path();
                let name = item.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if kind_of(&name) != "other" {
                    let r = rel(&dir, &path);
                    if !known.contains(&r) {
                        found.push(r);
                    }
                }
                if found.len() >= 200 {
                    return found;
                }
            }
        }
        found.sort();
        found
    })
    .await
    .unwrap_or_default()
}

/// The register as a tool result: each entry plus `exists`.
pub async fn list(root: &Path) -> Value {
    let manifest = match project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let dir = assets_dir(root, manifest.as_ref());
    let register = match read_register(&dir).await {
        Ok(r) => r,
        Err(note) => return fail(note),
    };
    let mut items = Vec::new();
    for entry in entries(&register) {
        let mut entry = entry.clone();
        let file = entry["file"].as_str().unwrap_or("").to_string();
        let path = dir.join(&file);
        let exists = !file.is_empty() && path.is_file();
        // Entries written by hand or by an older Studio lack the numbers the
        // drawer shows; read them from the file (not written back — listing
        // never changes the register).
        let lacks = match kind_of(&file) {
            "model" => entry.get("triangles").is_none(),
            "image" => entry.get("width").is_none() || entry.get("opaque").is_none(),
            _ => false,
        };
        if let Some(obj) = entry.as_object_mut() {
            if exists && lacks {
                if let Ok(bytes) = tokio::fs::read(&path).await {
                    for (k, v) in stats(&file, &bytes) {
                        obj.entry(k).or_insert(v);
                    }
                }
            }
            if exists && obj.get("bytes").is_none() {
                if let Ok(meta) = tokio::fs::metadata(&path).await {
                    obj.insert("bytes".into(), json!(meta.len()));
                }
            }
            if obj.get("kind").is_none() {
                obj.insert("kind".into(), json!(kind_of(&file)));
            }
            obj.insert("exists".into(), json!(exists));
        }
        let findings = studio_presets::check(&entry);
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("check".into(), Value::Array(findings));
        }
        items.push(entry);
    }
    let generator = generator_url(manifest.as_ref());
    let loose = unregistered(&dir, &register).await;
    json!({
        "ok": true,
        "assets_dir": rel(root, &dir),
        "generator": generator,
        "assets": items,
        "unregistered": loose,
        "presets": studio_presets::PRESETS,
        "note": if generator.is_none() {
            "No generator connected. Set `generate.url` in codeg-project.json (ask the user for the address) to use studio_generate_asset; studio_import_asset works without one."
        } else { "" },
    })
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

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|e| e.to_string())
}

/// Bytes and a guessed extension for a `data:` or http(s) URL.
async fn fetch(url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    if let Some(rest) = url.strip_prefix("data:") {
        let (meta, payload) = rest
            .split_once(',')
            .ok_or_else(|| "data: URL without a comma".to_string())?;
        if !meta.ends_with(";base64") {
            return Err("data: URL must be base64".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|e| format!("data: URL: {e}"))?;
        let mime = meta.trim_end_matches(";base64");
        return Ok((bytes, ext_for_mime(mime).map(str::to_string)));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("url must be http(s):// or a base64 data: URL".into());
    }
    let resp = http()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not fetch {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Fetching {url} answered {}", resp.status()));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err(format!("{url} is larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let mime_ext = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(ext_for_mime)
        .map(str::to_string);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Could not read {url}: {e}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("{url} is larger than {} MB", MAX_BYTES / 1024 / 1024));
    }
    let url_ext = Some(ext_of(url.split(['?', '#']).next().unwrap_or(url))).filter(|e| !e.is_empty());
    Ok((bytes.to_vec(), url_ext.or(mime_ext)))
}

/// Where a generator output lives on the generator (`3d/2026/10/07/x.glb`),
/// when `url` is one of its `/outputs/` files.
fn generator_output_path(generator: Option<&str>, url: &str) -> Option<String> {
    let base = generator?;
    let rest = url.strip_prefix(base)?.strip_prefix("/outputs/")?;
    let path = rest.split(['?', '#']).next().unwrap_or("");
    (!path.is_empty() && !path.split('/').any(|s| s == "..")).then(|| path.to_string())
}

/// Fetch `req.url` into `<assets>/`, register it, and drop the generator's
/// copy when it was one of the generator's outputs.
pub async fn import(root: &Path, req: ImportRequest) -> Value {
    let manifest = match project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let dir = assets_dir(root, manifest.as_ref());
    let generator = generator_url(manifest.as_ref());
    let url = req.url.trim().to_string();
    if let Some(id) = req.id.as_deref() {
        if !studio_scene::is_id(id) {
            return fail("id: letters, digits, - and _ (max 100)");
        }
    }
    if req.source.as_ref().is_some_and(|s| !s.is_object()) {
        return fail("source must be an object (workflow, prompt, seed, from, …)");
    }
    if let Some(note) = bad_use(req.use_for.as_deref()) {
        return fail(note);
    }
    let mut register = match read_register(&dir).await {
        Ok(r) => r,
        Err(note) => return fail(note),
    };
    // Either register a file already under assets/, or fetch one there.
    let (id, file, bytes_len, file_stats, written) = if let Some(existing) = req.file.as_deref() {
        let existing = existing.trim().trim_start_matches("./").replace('\\', "/");
        let (folder, name) = existing.rsplit_once('/').unwrap_or(("", existing.as_str()));
        if let Err(note) = safe_dir(folder) {
            return fail(note);
        }
        if name.is_empty() || name.starts_with('.') || name.contains("..") {
            return fail("file: a file name under assets/");
        }
        if kind_of(name) == "other" {
            return fail("Only images (png, jpg, webp, gif), models (glb, gltf) and videos (mp4, webm, mov) are materials.");
        }
        if entries(&register).iter().any(|e| e["file"] == existing.as_str()) {
            return fail(format!("{existing} is already registered"));
        }
        let bytes = match tokio::fs::read(dir.join(&existing)).await {
            Ok(b) => b,
            Err(e) => return fail(format!("Could not read assets/{existing}: {e}")),
        };
        let id = unique_id(&register, &req.id.clone().unwrap_or_else(|| id_from_name(name)));
        let st = stats(&existing, &bytes);
        (id, existing.clone(), bytes.len(), st, None)
    } else {
        let (bytes, ext) = match fetch(&url).await {
            Ok(v) => v,
            Err(note) => return fail(note),
        };
        let ext = match ext.filter(|e| kind_of(&format!("x.{e}")) != "other") {
            Some(e) => e,
            None => return fail("Only images (png, jpg, webp, gif), models (glb, gltf) and videos (mp4, webm, mov) are materials."),
        };
        let kind = kind_of(&format!("x.{ext}"));
        let sub = match req.dir.as_deref() {
            Some(d) => match safe_dir(d) {
                Ok(d) => d,
                Err(note) => return fail(note),
            },
            None => match kind {
                "model" => "generated/models",
                "video" => "generated/videos",
                _ => "generated/images",
            }
            .to_string(),
        };
        let wanted = req.id.clone().unwrap_or_else(|| {
            let name = url
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");
            id_from_name(if url.starts_with("data:") { "material" } else { name })
        });
        let id = unique_id(&register, &wanted);
        let file = if sub.is_empty() {
            format!("{id}.{ext}")
        } else {
            format!("{sub}/{id}.{ext}")
        };
        let path = dir.join(&file);
        if path.exists() {
            return fail(format!("{} already exists and is not in the register — pick another id, or register it with `file`", rel(root, &path)));
        }
        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return fail(format!("Could not create {}: {e}", rel(root, parent)));
            }
        }
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            return fail(format!("Could not write {}: {e}", rel(root, &path)));
        }
        let st = stats(&file, &bytes);
        (id, file, bytes.len(), st, Some(path))
    };
    let path = dir.join(&file);

    let mut entry = Map::new();
    entry.insert("id".into(), json!(id));
    entry.insert("file".into(), json!(file));
    entry.insert("kind".into(), json!(kind_of(&file)));
    if let Some(u) = &req.use_for {
        entry.insert("use".into(), json!(u));
    }
    entry.insert("bytes".into(), json!(bytes_len));
    entry.extend(file_stats);
    entry.insert("added_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    let mut source = req.source.clone().unwrap_or_else(|| json!({}));
    if !url.is_empty() && !url.starts_with("data:") {
        source["url"] = json!(url);
    }
    if source.as_object().is_some_and(|s| !s.is_empty()) {
        entry.insert("source".into(), source);
    }
    let entry = Value::Object(entry);
    register["assets"]
        .as_array_mut()
        .expect("read_register guarantees a list")
        .push(entry.clone());
    if let Err(note) = write_register(&dir, &register).await {
        if let Some(written) = written {
            let _ = tokio::fs::remove_file(&written).await;
        }
        return fail(note);
    }

    // The project now holds the material; the generator's copy goes.
    let mut remote_deleted = Value::Null;
    if let (Some(base), Some(out)) = (
        generator.as_deref(),
        generator_output_path(generator.as_deref(), &url),
    ) {
        remote_deleted = json!(delete_remote(base, &out).await);
    }
    json!({
        "ok": true,
        "asset": entry,
        "path": rel(root, &path),
        "remote_deleted": remote_deleted,
        "check": studio_presets::check(&entry),
        "note": "Registered in assets/manifest.json. The Studio's material panel picks it up from disk.",
    })
}

async fn delete_remote(base: &str, path: &str) -> bool {
    let Ok(client) = http() else { return false };
    client
        .delete(format!("{base}/api/outputs"))
        .query(&[("path", path)])
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

async fn data_url(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let mime = match ext_of(&path.to_string_lossy()).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        _ => "image/png",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// The image centred on a light-grey square, as an opaque PNG data URL — the
/// shape the T-pose redraw was measured with (model-pick bench/rig tpose.py):
/// the edit model keeps the figure whole when it has room on every side.
async fn squared_on_light(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Could not read the image {}: {e}", path.display()))?
        .to_rgba8();
    let side = img.width().max(img.height());
    let mut canvas = image::RgbaImage::from_pixel(side, side, image::Rgba([240, 240, 240, 255]));
    image::imageops::overlay(
        &mut canvas,
        &img,
        ((side - img.width()) / 2) as i64,
        ((side - img.height()) / 2) as i64,
    );
    let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the squared image: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    ))
}

/// The body sent to the generator and the provenance kept on the material.
/// Pure, so the shape is testable without a generator.
pub fn generator_call(
    req: &GenerateRequest,
    source_image: Option<String>,
    seed: i64,
) -> Result<(&'static str, Value, Value), String> {
    let prompt = req.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let mut source = json!({ "kind": req.kind, "seed": seed });
    if let Some(p) = prompt {
        source["prompt"] = json!(p);
    }
    if let Some(from) = &req.from {
        source["from"] = json!(from);
    }
    let cloud = req.provider.as_deref().is_some_and(|p| p.trim() != "comfyui");
    if req.kind != "image" && (cloud || req.model.is_some()) {
        return Err(format!(
            "`provider` / `model` pick who draws an `image`; kind `{}` runs on the generator's own GPU (pick a `workflow`)",
            req.kind
        ));
    }
    match req.kind.as_str() {
        "image" => {
            let prompt = prompt.ok_or("kind `image` needs a `prompt`")?;
            let provider = req.provider.as_deref().map(str::trim).filter(|p| !p.is_empty()).unwrap_or("comfyui");
            if !IMAGE_PROVIDERS.contains(&provider) {
                return Err(format!("provider `{provider}`: one of {}", IMAGE_PROVIDERS.join(", ")));
            }
            let model = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
            if provider == "comfyui" {
                if model.is_some() {
                    return Err("`model` is for a cloud provider; on comfyui pick a `workflow`".into());
                }
                let workflow = req.workflow.clone().unwrap_or_else(|| DEFAULT_IMAGE_WORKFLOW.into());
                let mut body = json!({
                    "prompt": shaped_prompt(&workflow, prompt),
                    "provider": "comfyui",
                    "workflow": workflow,
                    "seed": seed,
                });
                if let Some(img) = source_image {
                    body["source_image"] = json!(img);
                }
                source["workflow"] = json!(workflow);
                return Ok(("/api/images/generate", body, source));
            }
            if req.workflow.is_some() {
                return Err(format!("`workflow` is for comfyui; provider `{provider}` takes a `model`"));
            }
            if model.is_none() && provider != "codex" {
                return Err(format!(
                    "provider `{provider}` needs a `model`, e.g. {}",
                    CLOUD_IMAGES.iter().filter(|c| c.provider == provider).filter_map(|c| c.model).collect::<Vec<_>>().join(", ")
                ));
            }
            // A cloud picture is opaque; the 3D step cuts its own background.
            let mut body = json!({
                "prompt": prompt,
                "provider": provider,
                "seed": seed,
                "width": 1024,
                "height": 1024,
            });
            if let Some(m) = model {
                body["model"] = json!(m);
                source["model"] = json!(m);
            }
            if let Some(img) = source_image {
                body["reference_images"] = json!([img]);
            }
            source["provider"] = json!(provider);
            Ok(("/api/images/generate", body, source))
        }
        "3d" => {
            let img = source_image.ok_or("kind `3d` needs `from`: an image material to lift")?;
            let workflow = req.workflow.clone().unwrap_or_else(|| DEFAULT_3D_WORKFLOW.into());
            if let Some(t) = req.texture_size {
                if ![1024, 2048, 4096].contains(&t) {
                    return Err("texture_size must be 1024, 2048 or 4096".into());
                }
            }
            if let Some(f) = req.target_faces {
                if !(1000..=2_000_000).contains(&f) {
                    return Err("target_faces must be between 1000 and 2000000".into());
                }
            }
            let mut body = json!({ "source_image": img, "workflow": workflow, "seed": seed });
            let mut params = Map::new();
            if let Some(c) = req.compress_textures {
                body["compress_textures"] = json!(c);
                params.insert("compress_textures".into(), json!(c));
            }
            if let Some(f) = req.target_faces {
                body["target_faces"] = json!(f);
                params.insert("target_faces".into(), json!(f));
            }
            if let Some(t) = req.texture_size {
                body["texture_size"] = json!(t);
                params.insert("texture_size".into(), json!(t));
            }
            source["workflow"] = json!(workflow);
            if !params.is_empty() {
                source["params"] = Value::Object(params);
            }
            Ok(("/api/3d/generate", body, source))
        }
        "edit" | "tpose" => {
            let img = source_image.ok_or_else(|| format!("kind `{}` needs `from`: an image material", req.kind))?;
            let prompt = if req.kind == "tpose" {
                // A note the person adds ("keep the cape") rides after the recipe.
                match prompt {
                    Some(extra) => format!("{TPOSE_PROMPT}, {extra}"),
                    None => TPOSE_PROMPT.to_string(),
                }
            } else {
                prompt.ok_or("kind `edit` needs a `prompt`: what to change")?.to_string()
            };
            let workflow = req.workflow.clone().unwrap_or_else(|| DEFAULT_EDIT_WORKFLOW.into());
            let transparent = req.transparent.unwrap_or(true);
            let body = json!({
                "prompt": prompt,
                "provider": "comfyui",
                "workflow": workflow,
                "seed": seed,
                "source_image": img,
                "transparent": transparent,
            });
            source["workflow"] = json!(workflow);
            source["prompt"] = json!(prompt);
            Ok(("/api/images/generate", body, source))
        }
        "video" => {
            let img = source_image.ok_or("kind `video` needs `from`: an image material (a render keyframe) as the first frame")?;
            let prompt = prompt.ok_or("kind `video` needs a `prompt`: the motion, the camera, and an `Audio: …` line")?;
            let workflow = req.workflow.clone().unwrap_or_else(|| DEFAULT_VIDEO_WORKFLOW.into());
            let duration = req.duration.unwrap_or(5.0);
            if !(0.2..=15.0).contains(&duration) {
                return Err("duration: 0.2–15 seconds".into());
            }
            let width = req.width.unwrap_or(768);
            let height = req.height.unwrap_or(768);
            if !(256..=1920).contains(&width) || !(256..=1920).contains(&height) {
                return Err("width / height: 256–1920".into());
            }
            let body = json!({
                "prompt": prompt,
                "provider": "comfyui",
                "workflow": workflow,
                "seed": seed,
                "source_image": img,
                "width": width,
                "height": height,
                "duration": duration,
            });
            source["workflow"] = json!(workflow);
            source["params"] = json!({ "duration": duration, "width": width, "height": height });
            Ok(("/api/videos/generate", body, source))
        }
        "rig" => {
            let model = source_image.ok_or("kind `rig` needs `from`: a 3D model material (one standing character — a T-pose rigs best)")?;
            let body = json!({ "source_model": model, "seed": seed });
            source["workflow"] = json!("skintokens");
            Ok(("/api/3d/rig", body, source))
        }
        other => Err(format!("kind `{other}`: one of image, edit, tpose, 3d, rig, video")),
    }
}

/// Generate with the project's generator and import the result.
pub async fn generate(root: &Path, mut req: GenerateRequest) -> Value {
    if let Some(note) = bad_use(req.use_for.as_deref()) {
        return fail(note);
    }
    if let Some(preset) = req.use_for.as_deref().and_then(studio_presets::find) {
        if req.kind == "3d" {
            req.target_faces = req.target_faces.or(Some(preset.target_faces));
            req.texture_size = req.texture_size.or(Some(preset.texture_size));
        }
    }
    let manifest = match project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let Some(base) = generator_url(manifest.as_ref()) else {
        return fail("No generator connected. Set `generate.url` in codeg-project.json (ask the user for the address), or press Connect in the Studio's material panel.");
    };
    let dir = assets_dir(root, manifest.as_ref());
    let source_image = match req.from.as_deref() {
        None => None,
        Some(from) => {
            let register = match read_register(&dir).await {
                Ok(r) => r,
                Err(note) => return fail(note),
            };
            let Some(entry) = find(&register, from) else {
                return fail(format!("No material `{from}`. Call studio_list_assets for the ids."));
            };
            let file = entry["file"].as_str().unwrap_or("");
            let wants = if req.kind == "rig" { "model" } else { "image" };
            if kind_of(file) != wants {
                return fail(if wants == "model" {
                    format!("`{from}` is not a 3D model; `rig` takes a GLB material.")
                } else {
                    format!("`{from}` is not an image; kind `{}` takes an image material.", req.kind)
                });
            }
            let fed = if req.kind == "tpose" {
                squared_on_light(&dir.join(file)).await
            } else {
                data_url(&dir.join(file)).await
            };
            match fed {
                Ok(d) => Some(d),
                Err(note) => return fail(note),
            }
        }
    };
    let seed = req.seed.unwrap_or_else(|| rand::random::<u32>() as i64);
    let (route, body, source) = match generator_call(&req, source_image, seed) {
        Ok(v) => v,
        Err(note) => return fail(note),
    };
    let client = match http() {
        Ok(c) => c,
        Err(note) => return fail(note),
    };
    let resp = match client.post(format!("{base}{route}")).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return fail(format!(
                "The generator at {base} did not answer ({e}). It may be switched off — try again later."
            ))
        }
    };
    let status = resp.status();
    let result: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = result.get("detail").map(Value::to_string).unwrap_or_default();
        return fail(format!("The generator answered {status}. {detail}"));
    }
    let list_key = match req.kind.as_str() {
        "3d" | "rig" => "models",
        "video" => "videos",
        _ => "images",
    };
    let Some(out) = result[list_key].get(0) else {
        return fail("The generator answered without a result.");
    };
    let id = req.id.clone().or_else(|| match (&req.from, req.kind.as_str()) {
        (Some(from), "3d") => Some(format!("{from}-3d")),
        (Some(from), "tpose") => Some(format!("{from}-tpose")),
        (Some(from), "rig") => Some(format!("{from}-rig")),
        (Some(from), "video") => Some(format!("{from}-video")),
        (Some(from), "edit") => Some(format!("{from}-edit")),
        (Some(from), _) => Some(format!("{from}-redraw")),
        (None, _) => req.prompt.as_deref().map(id_from_prompt),
    });
    // A clip's real size and length (H3 snaps the frame count to its grid).
    let mut source = source;
    if req.kind == "video" {
        for key in ["width", "height", "frames", "fps"] {
            if let Some(v) = out.get(key).filter(|v| !v.is_null()) {
                source["params"][key] = v.clone();
            }
        }
        if out["has_audio"].as_bool() == Some(true) {
            source["audio"] = json!(true);
        }
    }
    let url = match (out["url"].as_str(), out["path"].as_str()) {
        (Some(u), _) if u.starts_with("http") => u.to_string(),
        (Some(u), _) => format!("{base}{u}"),
        (None, Some(p)) => format!("{base}/outputs/{p}"),
        _ => return fail("The generator's result has no url."),
    };
    import(
        root,
        ImportRequest {
            url,
            id,
            source: Some(source),
            use_for: req.use_for.clone(),
            ..Default::default()
        },
    )
    .await
}

/// Image workflows worth offering for a fresh drawing: text-to-image, no
/// LoRA slot, not a pipeline's internal step.
fn offered_image_workflow(w: &Value) -> bool {
    let name = w["name"].as_str().unwrap_or("");
    w["kind"] == "t2i"
        && w["supports_lora"] != true
        && !name.contains("lora")
        && !name.starts_with("cp-")
}

/// Video workflows that animate one image (the render keyframe).
fn offered_video_workflow(w: &Value) -> bool {
    let name = w["name"].as_str().unwrap_or("");
    w["kind"] == "i2v" && w["image_inputs"] == 1 && !name.starts_with("cp-")
}

/// What each step can be asked for, shaped from the generator's workflow
/// lists (`GET /api/images/workflows` · `/api/videos/workflows`) plus
/// [`CLOUD_IMAGES`] and the 3D presets. The cards' settings and
/// `studio_generator_options` read this; `generate` validates the choice.
pub fn shape_options(images: Option<&Value>, videos: Option<&Value>) -> Value {
    let details = |v: Option<&Value>| v.and_then(|v| v["details"].as_array()).cloned().unwrap_or_default();
    let mut image: Vec<Value> = details(images)
        .iter()
        .filter(|w| offered_image_workflow(w))
        .map(|w| {
            let name = w["name"].as_str().unwrap_or("");
            json!({
                "provider": "comfyui",
                "workflow": name,
                "label": name,
                "billing": "local",
                "transparent": name.contains("rgba"),
                "default": name == DEFAULT_IMAGE_WORKFLOW,
            })
        })
        .collect();
    // The default first, then the generator's order.
    image.sort_by_key(|o| o["default"] != true);
    image.extend(CLOUD_IMAGES.iter().map(|c| {
        let mut o = serde_json::to_value(c).unwrap_or_default();
        if c.model.is_none() {
            o.as_object_mut().map(|m| m.remove("model"));
        }
        o
    }));
    let video: Vec<Value> = details(videos)
        .iter()
        .filter(|w| offered_video_workflow(w))
        .map(|w| {
            let name = w["name"].as_str().unwrap_or("");
            json!({
                "provider": "comfyui",
                "workflow": name,
                "label": name,
                "billing": "local",
                "audio": w["has_audio"] == true,
                "min_duration": w["preset"]["min_duration"],
                "default": name == DEFAULT_VIDEO_WORKFLOW,
            })
        })
        .collect();
    json!({
        "image": image,
        "video": video,
        "model": {
            "workflow": DEFAULT_3D_WORKFLOW,
            "texture_sizes": [1024, 2048, 4096],
            "target_faces": { "min": 1000, "max": 2_000_000 },
            "presets": studio_presets::PRESETS,
        },
        "duration": { "min": 0.2, "max": 15.0, "default": 5.0 },
        "defaults": {
            "image": { "provider": "comfyui", "workflow": DEFAULT_IMAGE_WORKFLOW },
            "video": { "provider": "comfyui", "workflow": DEFAULT_VIDEO_WORKFLOW },
        },
    })
}

/// [`shape_options`] for the project's generator. `url` overrides it (the
/// first screen has no project yet).
pub async fn options(root: &Path, url: Option<String>) -> Value {
    let base = match url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()) {
        Some(u) => Some(u),
        None => match project(root).await {
            Ok(m) => generator_url(m.as_ref()),
            Err(note) => return fail(note),
        },
    };
    // `note_code` lets the cards say it in the person's language.
    let mut note = None;
    let (images, videos) = match &base {
        None => {
            note = Some(("no_generator", "No generator connected — only cloud pictures are listed. Set `generate.url` in codeg-project.json.".to_string()));
            (None, None)
        }
        Some(base) => {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .ok();
            let get = |path: &'static str| {
                let client = client.clone();
                let url = format!("{base}{path}");
                async move {
                    let resp = client?.get(url).send().await.ok()?;
                    if !resp.status().is_success() {
                        return None;
                    }
                    resp.json::<Value>().await.ok()
                }
            };
            let (i, v) = tokio::join!(get("/api/images/workflows"), get("/api/videos/workflows"));
            if i.is_none() {
                note = Some(("generator_off", format!("The generator at {base} did not list its workflows — it may be switched off or busy.")));
            }
            (i, v)
        }
    };
    let mut out = shape_options(images.as_ref(), videos.as_ref());
    out["ok"] = json!(true);
    out["generator"] = json!(base);
    if let Some((code, n)) = note {
        out["note"] = json!(n);
        out["note_code"] = json!(code);
    }
    out
}

fn bad_use(use_for: Option<&str>) -> Option<String> {
    let u = use_for?;
    studio_presets::find(u).is_none().then(|| {
        format!("use `{u}`: one of {}", studio_presets::ids().join(", "))
    })
}

/// Set (or clear, with `None`) where a material will be used.
pub async fn update(root: &Path, id: &str, use_for: Option<String>) -> Value {
    if let Some(note) = bad_use(use_for.as_deref()) {
        return fail(note);
    }
    let manifest = match project(root).await {
        Ok(m) => m,
        Err(note) => return fail(note),
    };
    let dir = assets_dir(root, manifest.as_ref());
    let mut register = match read_register(&dir).await {
        Ok(r) => r,
        Err(note) => return fail(note),
    };
    let Some(entry) = register["assets"]
        .as_array_mut()
        .and_then(|list| list.iter_mut().find(|e| e["id"] == id))
        .and_then(Value::as_object_mut)
    else {
        return fail(format!("No material `{id}`. Call studio_list_assets for the ids."));
    };
    match &use_for {
        Some(u) => {
            entry.insert("use".into(), json!(u));
        }
        None => {
            entry.remove("use");
        }
    }
    let updated = Value::Object(entry.clone());
    if let Err(note) = write_register(&dir, &register).await {
        return fail(note);
    }
    json!({ "ok": true, "asset": updated, "check": studio_presets::check(&updated) })
}

/// Set (or clear, with `None`) `generate.url` in the manifest.
pub async fn connect(root: &Path, url: Option<String>) -> Value {
    let url = url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &url {
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return fail("The generator address must start with http:// or https://");
        }
    }
    match cp::set_generator(root, url.clone()).await {
        Ok(()) => json!({ "ok": true, "generator": url }),
        Err(e) => fail(e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = cp::create_content_project(
            "assets-check".into(),
            dir.path().to_string_lossy().to_string(),
            "web-three".into(),
            vec!["game".into()],
        )
        .await
        .unwrap();
        (dir, PathBuf::from(path))
    }

    fn png_data_url() -> String {
        let mut bytes = Vec::new();
        image::RgbaImage::new(3, 2)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[tokio::test]
    async fn import_registers_with_provenance_and_keeps_unknown_fields() {
        let (_tmp, root) = project().await;
        let reg = root.join("assets/manifest.json");
        let mut seeded: Value = serde_json::from_str(&std::fs::read_to_string(&reg).unwrap()).unwrap();
        seeded["assets"] = json!([{ "id": "old", "file": "ui/old.png", "role": "ui-frame" }]);
        std::fs::write(&reg, seeded.to_string()).unwrap();

        let out = import(
            &root,
            ImportRequest {
                url: png_data_url(),
                id: Some("old".into()),
                source: Some(json!({ "workflow": "qwen-image-21-rgba", "seed": 7, "prompt": "a cup" })),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["asset"]["id"], "old-2", "a taken id gets a suffix");
        assert_eq!(out["asset"]["file"], "generated/images/old-2.png");
        assert_eq!(out["asset"]["width"], 3);
        assert_eq!(out["asset"]["source"]["seed"], 7);
        assert!(root.join("assets/generated/images/old-2.png").is_file());

        let listed = list(&root).await;
        assert_eq!(listed["ok"], true);
        let items = listed["assets"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["role"], "ui-frame", "unknown fields survive");
        assert_eq!(items[0]["exists"], false);
        assert_eq!(items[1]["exists"], true);
        assert!(listed["generator"].is_null());
    }

    #[tokio::test]
    async fn refusals_are_readable() {
        let (_tmp, root) = project().await;
        let bad_dir = import(
            &root,
            ImportRequest { url: png_data_url(), dir: Some("../x".into()), ..Default::default() },
        )
        .await;
        assert_eq!(bad_dir["ok"], false);
        let bad_kind = import(
            &root,
            ImportRequest { url: "data:text/plain;base64,aGk=".into(), ..Default::default() },
        )
        .await;
        assert_eq!(bad_kind["ok"], false);
        let no_gen = generate(
            &root,
            GenerateRequest { kind: "image".into(), prompt: Some("x".into()), ..Default::default() },
        )
        .await;
        assert_eq!(no_gen["ok"], false);
        assert!(no_gen["note"].as_str().unwrap().contains("generate.url"));

        let mpath = root.join("codeg-project.json");
        let mut m: Value = serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        m["custom"] = json!({ "keep": true });
        std::fs::write(&mpath, m.to_string()).unwrap();
        let connected = connect(&root, Some("http://gen.local/".into())).await;
        assert_eq!(connected["generator"], "http://gen.local");
        let raw = std::fs::read_to_string(&mpath).unwrap();
        assert!(raw.starts_with("{\n  \"schema\""), "scaffold order kept: {raw}");
        assert!(raw.contains("\"keep\": true"), "unknown fields kept");
        let missing_from = generate(
            &root,
            GenerateRequest { kind: "3d".into(), from: Some("nope".into()), ..Default::default() },
        )
        .await;
        assert!(missing_from["note"].as_str().unwrap().contains("studio_list_assets"));
        assert_eq!(list(&root).await["generator"], "http://gen.local");
        assert_eq!(connect(&root, None).await["ok"], true);
        assert!(list(&root).await["generator"].is_null());
    }

    fn tiny_glb() -> Vec<u8> {
        let mut png = Vec::new();
        image::RgbaImage::new(8, 4)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        while !png.len().is_multiple_of(4) {
            png.push(0);
        }
        let gltf = json!({
            "asset": { "version": "2.0" },
            "accessors": [{ "count": 6 }, { "count": 4 }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 1 }, "indices": 0 }] }],
            "bufferViews": [{ "buffer": 0, "byteOffset": 0, "byteLength": png.len() }],
            "images": [{ "bufferView": 0, "mimeType": "image/png" }],
        });
        let mut j = serde_json::to_vec(&gltf).unwrap();
        while !j.len().is_multiple_of(4) {
            j.push(b' ');
        }
        let total = 12 + 8 + j.len() + 8 + png.len();
        let mut out = Vec::new();
        out.extend(b"glTF");
        out.extend(2u32.to_le_bytes());
        out.extend((total as u32).to_le_bytes());
        out.extend((j.len() as u32).to_le_bytes());
        out.extend(b"JSON");
        out.extend(&j);
        out.extend((png.len() as u32).to_le_bytes());
        out.extend(b"BIN\0");
        out.extend(&png);
        out
    }

    #[test]
    fn model_stats_read_faces_and_textures() {
        let st = stats("x.glb", &tiny_glb());
        assert_eq!(st["triangles"], 2);
        assert_eq!(st["vertices"], 4);
        assert_eq!(st["textures"], json!([[8, 4]]));
        assert_eq!(st["texture_max"], 8);
        assert!(stats("x.glb", b"not a model").is_empty());
        assert!(st.get("bones").is_none(), "a static mesh has no bones");
        let rigged = serde_json::to_vec(&json!({
            "asset": { "version": "2.0" },
            "skins": [{ "joints": [0, 1, 2] }, { "joints": [0] }],
            "animations": [{ "name": "walk" }],
        }))
        .unwrap();
        let st = stats("x.gltf", &rigged);
        assert_eq!(st["bones"], 3);
        assert_eq!(st["animations"], 1);
    }

    #[tokio::test]
    async fn hand_placed_files_are_listed_then_registered_in_place() {
        let (_tmp, root) = project().await;
        std::fs::create_dir_all(root.join("assets/props")).unwrap();
        std::fs::write(root.join("assets/props/chest.glb"), tiny_glb()).unwrap();
        let listed = list(&root).await;
        assert_eq!(listed["unregistered"], json!(["props/chest.glb"]));

        let out = import(
            &root,
            ImportRequest { file: Some("props/chest.glb".into()), ..Default::default() },
        )
        .await;
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["asset"]["id"], "chest");
        assert_eq!(out["asset"]["triangles"], 2);
        assert_eq!(out["asset"]["kind"], "model");
        let listed = list(&root).await;
        assert_eq!(listed["unregistered"], json!([]));
        assert_eq!(listed["assets"][0]["texture_max"], 8);

        let again = import(
            &root,
            ImportRequest { file: Some("props/chest.glb".into()), ..Default::default() },
        )
        .await;
        assert!(again["note"].as_str().unwrap().contains("already registered"));
        let escape = import(
            &root,
            ImportRequest { file: Some("../codeg-project.json".into()), ..Default::default() },
        )
        .await;
        assert_eq!(escape["ok"], false);
    }

    #[tokio::test]
    async fn use_is_recorded_and_judged() {
        let (_tmp, root) = project().await;
        std::fs::create_dir_all(root.join("assets/props")).unwrap();
        std::fs::write(root.join("assets/props/chest.glb"), tiny_glb()).unwrap();
        let bad = import(
            &root,
            ImportRequest { file: Some("props/chest.glb".into()), use_for: Some("moon".into()), ..Default::default() },
        )
        .await;
        assert!(bad["note"].as_str().unwrap().contains("web-ar"));
        let out = import(
            &root,
            ImportRequest { file: Some("props/chest.glb".into()), use_for: Some("web-ar".into()), ..Default::default() },
        )
        .await;
        assert_eq!(out["asset"]["use"], "web-ar");
        assert_eq!(out["check"][0]["code"], "tris_below");
        let listed = list(&root).await;
        assert_eq!(listed["assets"][0]["check"][0]["code"], "tris_below");
        assert!(listed["presets"].as_array().unwrap().len() >= 6);
        let cleared = update(&root, "chest", None).await;
        assert_eq!(cleared["ok"], true);
        assert!(cleared["asset"].get("use").is_none());
        assert_eq!(update(&root, "ghost", None).await["ok"], false);
    }

    #[test]
    fn generator_call_shapes() {
        let req = GenerateRequest {
            kind: "3d".into(),
            from: Some("cup".into()),
            target_faces: Some(10_000),
            texture_size: Some(2048),
            ..Default::default()
        };
        let (route, body, source) = generator_call(&req, Some("data:x".into()), 5).unwrap();
        assert_eq!(route, "/api/3d/generate");
        assert_eq!(body["source_image"], "data:x");
        assert_eq!(body["target_faces"], 10_000);
        assert_eq!(source["from"], "cup");
        assert_eq!(source["workflow"], "trellis2");
        assert_eq!(source["params"]["texture_size"], 2048);

        assert!(generator_call(&GenerateRequest { kind: "3d".into(), ..Default::default() }, None, 1).is_err());
        let bad_tex = GenerateRequest { kind: "3d".into(), texture_size: Some(999), ..Default::default() };
        assert!(generator_call(&bad_tex, Some("d".into()), 1).is_err());
        let img = GenerateRequest { kind: "image".into(), prompt: Some(" a cup ".into()), ..Default::default() };
        let (route, body, source) = generator_call(&img, None, 9).unwrap();
        assert_eq!(route, "/api/images/generate");
        assert_eq!(body["workflow"], "qwen-image-21-rgba");
        assert_eq!(
            body["prompt"],
            "This is an RGBA format image with transparency. a cup. The image has an alpha channel and a transparent background."
        );
        // Provenance keeps what the person typed.
        assert_eq!(source["prompt"], "a cup");
        assert!(body.get("source_image").is_none());
        // Target faces ride at the top of the body, where genai reads them.
        assert!(body.get("extra").is_none());
    }

    #[test]
    fn picture_providers_are_validated_once_for_both_doors() {
        let ask = |provider: Option<&str>, model: Option<&str>, workflow: Option<&str>| GenerateRequest {
            kind: "image".into(),
            prompt: Some("a teacup".into()),
            provider: provider.map(String::from),
            model: model.map(String::from),
            workflow: workflow.map(String::from),
            ..Default::default()
        };
        let (_, body, source) =
            generator_call(&ask(Some("openrouter"), Some("google/gemini-nano-banana-2.1"), None), None, 3).unwrap();
        assert_eq!(body["provider"], "openrouter");
        assert_eq!(body["model"], "google/gemini-nano-banana-2.1");
        assert_eq!(body["prompt"], "a teacup", "no RGBA wrapping off comfyui");
        assert!(body.get("workflow").is_none());
        assert_eq!(source["provider"], "openrouter");
        assert_eq!(source["model"], "google/gemini-nano-banana-2.1");

        let (_, body, source) = generator_call(&ask(Some("codex"), None, None), Some("data:y".into()), 3).unwrap();
        assert_eq!(body["provider"], "codex");
        assert!(body.get("model").is_none());
        assert_eq!(body["reference_images"][0], "data:y");
        assert_eq!(source["provider"], "codex");

        let (_, body, _) = generator_call(&ask(Some("comfyui"), None, Some("z-image-turbo")), None, 3).unwrap();
        assert_eq!(body["workflow"], "z-image-turbo");
        assert_eq!(body["prompt"], "a teacup");

        for (p, m, w) in [
            (Some("midjourney"), None, None),
            (Some("openrouter"), None, None),
            (Some("openrouter"), Some("x"), Some("qwen-image-21")),
            (None, Some("google/gemini-nano-banana-2.1"), None),
        ] {
            assert!(generator_call(&ask(p, m, w), None, 1).is_err(), "{p:?} {m:?} {w:?}");
        }
        let cloud_3d = GenerateRequest { kind: "3d".into(), provider: Some("codex".into()), ..Default::default() };
        assert!(generator_call(&cloud_3d, Some("d".into()), 1).is_err());
        let lift = GenerateRequest {
            kind: "3d".into(),
            provider: Some("comfyui".into()),
            compress_textures: Some(true),
            ..Default::default()
        };
        let (_, body, source) = generator_call(&lift, Some("d".into()), 1).unwrap();
        assert_eq!(body["compress_textures"], true);
        assert_eq!(source["params"]["compress_textures"], true);
    }

    #[test]
    fn options_offer_drawing_workflows_and_cloud_pictures() {
        let images = json!({ "details": [
            { "name": "flux2-klein-4b", "kind": "t2i", "supports_lora": false },
            { "name": "qwen-image-21-rgba", "kind": "t2i", "supports_lora": false },
            { "name": "qwen-image-lora", "kind": "t2i", "supports_lora": true },
            { "name": "z-image-turbo-lora", "kind": "t2i", "supports_lora": false },
            { "name": "qwen-image-21-edit", "kind": "edit" },
            { "name": "cp-w3-spritesheet-16f", "kind": "t2i" },
        ]});
        let videos = json!({ "details": [
            { "name": "minimax-h3-i2v", "kind": "i2v", "image_inputs": 1, "has_audio": true, "preset": { "min_duration": 5.0 } },
            { "name": "minimax-h3-i2v-2ref", "kind": "i2v", "image_inputs": 2 },
            { "name": "minimax-h3-t2v", "kind": "t2v", "image_inputs": 0 },
            { "name": "cp-w2-video-gen", "kind": "i2v", "image_inputs": 1 },
        ]});
        let o = shape_options(Some(&images), Some(&videos));
        let workflows: Vec<_> = o["image"].as_array().unwrap().iter().filter_map(|i| i["workflow"].as_str()).collect();
        assert_eq!(workflows, ["qwen-image-21-rgba", "flux2-klein-4b"], "default first, no LoRA / edit / pipeline steps");
        assert_eq!(o["image"][0]["transparent"], true);
        let cloud: Vec<_> = o["image"].as_array().unwrap().iter().filter(|i| i["provider"] != "comfyui").collect();
        assert_eq!(cloud.len(), CLOUD_IMAGES.len());
        assert!(cloud.iter().any(|c| c["provider"] == "codex" && c["billing"] == "subscription" && c.get("model").is_none()));
        assert!(cloud.iter().any(|c| c["model"] == "google/gemini-nano-banana-2.1" && c["usd"] == 0.034));
        assert_eq!(o["video"].as_array().unwrap().len(), 1);
        assert_eq!(o["video"][0]["audio"], true);
        assert_eq!(o["model"]["presets"].as_array().unwrap().len(), studio_presets::PRESETS.len());
        // Every offered choice passes the validator.
        for i in o["image"].as_array().unwrap() {
            let req = GenerateRequest {
                kind: "image".into(),
                prompt: Some("x".into()),
                provider: i["provider"].as_str().map(String::from),
                workflow: i["workflow"].as_str().map(String::from),
                model: i["model"].as_str().map(String::from),
                ..Default::default()
            };
            assert!(generator_call(&req, None, 1).is_ok(), "{i}");
        }
        // Generator off: cloud pictures only.
        let off = shape_options(None, None);
        assert_eq!(off["image"].as_array().unwrap().len(), CLOUD_IMAGES.len());
    }

    #[test]
    fn step_kinds_call_the_right_routes() {
        let tpose = GenerateRequest { kind: "tpose".into(), from: Some("hero".into()), ..Default::default() };
        let (route, body, source) = generator_call(&tpose, Some("data:img".into()), 3).unwrap();
        assert_eq!(route, "/api/images/generate");
        assert_eq!(body["workflow"], "qwen-image-21-edit");
        assert_eq!(body["prompt"], TPOSE_PROMPT);
        assert_eq!(body["transparent"], true);
        assert_eq!(source["from"], "hero");
        let noted = GenerateRequest { prompt: Some("keep the cape".into()), ..tpose.clone() };
        let (_, body, _) = generator_call(&noted, Some("d".into()), 3).unwrap();
        assert!(body["prompt"].as_str().unwrap().ends_with(", keep the cape"));

        let edit = GenerateRequest { kind: "edit".into(), from: Some("k".into()), ..Default::default() };
        assert!(generator_call(&edit, Some("d".into()), 1).is_err(), "edit needs a prompt");

        let video = GenerateRequest {
            kind: "video".into(),
            from: Some("cup-f001".into()),
            prompt: Some("slow orbit. Audio: soft clink".into()),
            ..Default::default()
        };
        let (route, body, source) = generator_call(&video, Some("data:key".into()), 4).unwrap();
        assert_eq!(route, "/api/videos/generate");
        assert_eq!(body["workflow"], "minimax-h3-i2v");
        assert_eq!(body["source_image"], "data:key");
        assert_eq!((body["width"].as_u64(), body["duration"].as_f64()), (Some(768), Some(5.0)));
        assert_eq!(source["params"]["duration"], 5.0);
        assert!(generator_call(&GenerateRequest { prompt: None, ..video.clone() }, Some("d".into()), 1).is_err());
        assert!(generator_call(&GenerateRequest { duration: Some(30.0), ..video.clone() }, Some("d".into()), 1).is_err());
        assert!(generator_call(&video, None, 1).is_err(), "video needs a first frame");

        let rig = GenerateRequest { kind: "rig".into(), from: Some("hero-3d".into()), ..Default::default() };
        let (route, body, source) = generator_call(&rig, Some("data:model/gltf-binary;base64,AA".into()), 2).unwrap();
        assert_eq!(route, "/api/3d/rig");
        assert_eq!(body["source_model"], "data:model/gltf-binary;base64,AA");
        assert_eq!(source["workflow"], "skintokens");
        assert!(generator_call(&GenerateRequest { kind: "film".into(), ..Default::default() }, None, 1).is_err());
    }

    #[tokio::test]
    async fn tpose_input_is_squared_on_light_grey() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("tall.png");
        image::RgbaImage::from_pixel(2, 4, image::Rgba([10, 20, 30, 0])).save(&path).unwrap();
        let url = squared_on_light(&path).await.unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (4, 4));
        assert!(!img.color().has_alpha());
        assert_eq!(img.to_rgb8().get_pixel(0, 0).0, [240, 240, 240]);
    }

    #[test]
    fn rgba_prompts_are_wrapped_once() {
        assert_eq!(shaped_prompt("qwen-image-21", "a cup"), "a cup");
        let once = shaped_prompt("qwen-image-21-rgba", "a red cup.");
        assert!(once.starts_with(RGBA_LEAD) && once.contains(" a red cup. ") && once.ends_with(RGBA_TAIL));
        assert_eq!(shaped_prompt("qwen-image-21-rgba", &once), once);
    }

    #[test]
    fn writes_keep_a_readable_key_order() {
        let v = json!({ "schema": 1, "assets": [{ "source": {}, "file": "a.png", "id": "a" }], "container": "1x1" });
        let text = serde_json::to_string(&Ordered {
            value: &v,
            first: REGISTER_ORDER,
            children: Some(("assets", ENTRY_ORDER)),
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"schema":1,"container":"1x1","assets":[{"id":"a","file":"a.png","source":{}}]}"#
        );
        assert_eq!(id_from_prompt("A cute teacup, red glaze"), "a-cute-teacup-red");
        assert_eq!(id_from_prompt("빨간 찻잔"), "image");
    }

    #[test]
    fn generator_outputs_are_recognised() {
        let base = Some("https://gen.example");
        assert_eq!(
            generator_output_path(base, "https://gen.example/outputs/3d/2026/10/07/a.glb").as_deref(),
            Some("3d/2026/10/07/a.glb")
        );
        assert_eq!(generator_output_path(base, "https://other/outputs/a.png"), None);
        assert_eq!(generator_output_path(base, "https://gen.example/outputs/../x"), None);
        assert_eq!(generator_output_path(None, "https://gen.example/outputs/a.png"), None);
    }
}
