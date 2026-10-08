//! "Where will this be used" — the budgets a material is judged by, and the
//! generator values each one implies. One table for the editor and the
//! companion's `studio_*` tools: the editor reads it from `list_assets`
//! (`presets`), the tools from the same result, and both get the same
//! `check` on every entry.
//!
//! Numbers are the 2026-10-07 survey (asks asset-workbench): mobile prop
//! 300–1.5k tris · mobile character 3k–10k · Roblox MeshPart hard cap 21k,
//! recommended under 10k · web/AR (Scene Viewer) 30k–50k, texture ≤ 2048,
//! ≤ 5 MB · PC/console hero tens of thousands to ~100k · 3D print hundreds
//! of thousands, closed mesh. The generator is only told faces and texture
//! size — never what the material is for.

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Preset {
    pub id: &'static str,
    /// Recommended triangle range; outside it is a warning.
    pub tris: (u64, u64),
    /// Above this the material does not work there at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tris_hard_max: Option<u64>,
    /// Largest texture side.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub texture_max: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_max: Option<u64>,
    /// What the generator is asked for (`target_faces`, `texture_size`).
    pub target_faces: u32,
    pub texture_size: u32,
    /// Needs a closed (watertight) mesh — not checked yet, only reported.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub closed_mesh: bool,
}

const MB: u64 = 1024 * 1024;

pub const PRESETS: &[Preset] = &[
    Preset {
        id: "mobile-prop",
        tris: (300, 1_500),
        tris_hard_max: None,
        texture_max: Some(2048),
        bytes_max: Some(5 * MB),
        // genai's floor is 1000 faces.
        target_faces: 1_000,
        texture_size: 1024,
        closed_mesh: false,
    },
    Preset {
        id: "mobile-character",
        tris: (3_000, 10_000),
        tris_hard_max: None,
        texture_max: Some(2048),
        bytes_max: Some(5 * MB),
        target_faces: 8_000,
        texture_size: 2048,
        closed_mesh: false,
    },
    Preset {
        id: "roblox-meshpart",
        tris: (3_000, 10_000),
        tris_hard_max: Some(21_000),
        texture_max: Some(2048),
        bytes_max: None,
        target_faces: 8_000,
        texture_size: 1024,
        closed_mesh: false,
    },
    Preset {
        id: "web-ar",
        tris: (30_000, 50_000),
        tris_hard_max: None,
        texture_max: Some(2048),
        bytes_max: Some(5 * MB),
        target_faces: 40_000,
        texture_size: 2048,
        closed_mesh: false,
    },
    Preset {
        id: "pc-hero",
        tris: (20_000, 100_000),
        tris_hard_max: None,
        texture_max: Some(4096),
        bytes_max: None,
        target_faces: 80_000,
        texture_size: 4096,
        closed_mesh: false,
    },
    Preset {
        id: "print-3d",
        tris: (100_000, 2_000_000),
        tris_hard_max: None,
        texture_max: None,
        bytes_max: None,
        target_faces: 300_000,
        texture_size: 1024,
        closed_mesh: true,
    },
];

pub fn find(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

pub fn ids() -> Vec<&'static str> {
    PRESETS.iter().map(|p| p.id).collect()
}

fn finding(level: &str, code: &str, value: u64, limit: u64, message: String) -> Value {
    json!({ "level": level, "code": code, "value": value, "limit": limit, "message": message })
}

/// Judge one register entry (with its numbers filled in) against the preset
/// named in its `use`, plus checks that hold whatever the use. `level` is
/// `over` (does not work there), `warn` (outside the recommendation) or
/// `info`. Empty when nothing is off.
pub fn check(entry: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let num = |k: &str| entry.get(k).and_then(Value::as_u64);
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");

    // An image from a transparent workflow that came back opaque: the 3D
    // lift and any sprite use will carry its background along.
    if kind == "image" && entry.get("opaque") == Some(&Value::Bool(true)) {
        let wanted_alpha = entry
            .pointer("/source/workflow")
            .and_then(Value::as_str)
            .is_some_and(|w| w.contains("rgba"))
            || entry.pointer("/source/transparent") == Some(&Value::Bool(true));
        if wanted_alpha {
            out.push(finding(
                "warn",
                "not_transparent",
                0,
                0,
                "Made by a transparent workflow but has no transparent pixels".into(),
            ));
        }
    }

    let Some(preset) = entry.get("use").and_then(Value::as_str).and_then(find) else {
        return out;
    };
    if kind == "model" {
        if let Some(tris) = num("triangles") {
            let (lo, hi) = preset.tris;
            match preset.tris_hard_max {
                Some(cap) if tris > cap => out.push(finding(
                    "over",
                    "tris_over_cap",
                    tris,
                    cap,
                    format!("{tris} triangles — {} allows at most {cap}", preset.id),
                )),
                _ if tris > hi => out.push(finding(
                    "warn",
                    "tris_above",
                    tris,
                    hi,
                    format!("{tris} triangles — {} recommends at most {hi}", preset.id),
                )),
                _ if tris < lo => out.push(finding(
                    "info",
                    "tris_below",
                    tris,
                    lo,
                    format!("{tris} triangles — {} usually has {lo}+", preset.id),
                )),
                _ => {}
            }
        }
        if preset.closed_mesh {
            out.push(finding(
                "info",
                "closed_mesh_unchecked",
                0,
                0,
                "Printing needs a closed mesh; not checked here".into(),
            ));
        }
    }
    let texture = num("texture_max").or_else(|| {
        (kind == "image")
            .then(|| Some(num("width")?.max(num("height")?)))
            .flatten()
    });
    if let (Some(tex), Some(max)) = (texture, preset.texture_max) {
        if tex > max {
            out.push(finding(
                "warn",
                "texture_above",
                tex,
                max,
                format!("texture {tex}px — {} keeps it at {max}px or less", preset.id),
            ));
        }
    }
    if let (Some(bytes), Some(max)) = (num("bytes"), preset.bytes_max) {
        if bytes > max {
            out.push(finding(
                "warn",
                "bytes_above",
                bytes,
                max,
                format!(
                    "{:.1} MB — {} keeps a file under {} MB",
                    bytes as f64 / MB as f64,
                    preset.id,
                    max / MB
                ),
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_teacup_case_is_flagged_for_web_ar() {
        // The 2026-10-07 lift: asked for 10k faces, got 282,974 · 18.2 MB.
        let cup = json!({
            "kind": "model", "use": "web-ar", "triangles": 282_974u64,
            "texture_max": 2048, "bytes": 19_062_484u64
        });
        let codes: Vec<_> = check(&cup).iter().map(|f| f["code"].clone()).collect();
        assert_eq!(codes, vec![json!("tris_above"), json!("bytes_above")]);
    }

    #[test]
    fn hard_caps_and_floors() {
        let part = json!({ "kind": "model", "use": "roblox-meshpart", "triangles": 25_000 });
        assert_eq!(check(&part)[0]["level"], "over");
        let soft = json!({ "kind": "model", "use": "roblox-meshpart", "triangles": 12_000 });
        assert_eq!(check(&soft)[0]["code"], "tris_above");
        let tiny = json!({ "kind": "model", "use": "pc-hero", "triangles": 500, "texture_max": 8192 });
        let codes: Vec<_> = check(&tiny).iter().map(|f| f["code"].clone()).collect();
        assert_eq!(codes, vec![json!("tris_below"), json!("texture_above")]);
        let print = json!({ "kind": "model", "use": "print-3d", "triangles": 400_000 });
        assert_eq!(check(&print)[0]["code"], "closed_mesh_unchecked");
        assert!(check(&json!({ "kind": "model", "use": "nope", "triangles": 9 })).is_empty());
        assert!(check(&json!({ "kind": "model", "triangles": 9_999_999 })).is_empty());
    }

    #[test]
    fn opaque_output_of_a_transparent_workflow() {
        let img = json!({ "kind": "image", "opaque": true, "source": { "workflow": "qwen-image-21-rgba" } });
        assert_eq!(check(&img)[0]["code"], "not_transparent");
        let photo = json!({ "kind": "image", "opaque": true, "source": { "workflow": "flux" } });
        assert!(check(&photo).is_empty());
    }

    #[test]
    fn every_preset_asks_the_generator_for_valid_values() {
        for p in PRESETS {
            assert!((1000..=2_000_000).contains(&p.target_faces), "{}", p.id);
            assert!([1024, 2048, 4096].contains(&p.texture_size), "{}", p.id);
            assert!(p.tris.0 < p.tris.1, "{}", p.id);
        }
    }
}
