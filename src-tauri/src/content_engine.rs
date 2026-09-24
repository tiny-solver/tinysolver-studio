//! The game runtime Tinysolver Studio provides to content projects.
//!
//! A project does not carry engine code. Its `index.html` import-maps
//! `codeg-engine` and `three` to `../../__codeg/…`, and that reserved prefix
//! is answered from the files embedded here:
//!
//! - the preview server ([`crate::content_preview`]) serves them virtually,
//!   so every project previews with the engine of the running Studio;
//! - a build ([`crate::commands::content_project::build_content_project`])
//!   writes them into the build folder at the same relative path, so the
//!   packaged game is self-contained — no CDN, no Studio.
//!
//! Three.js is vendored (MIT, the file keeps its license header) because a
//! release that needs unpkg to be up is not a release.
//!
//! ## Platform layer (`codeg-platform`)
//!
//! Games reach saves, the player, leaderboards, sharing and ads through one
//! module, import-mapped to [`PLATFORM_ENTRY`]. Which file answers that path
//! is the build *target*: the preview always gets the `studio` fake, a build
//! writes the adapter of its target (`web` for now; afterplay, Tauri and
//! Capacitor later). The game code is the same everywhere. Projects created
//! before the layer existed have no import-map entry for it —
//! [`with_platform_import`] adds one when the page is served or packaged.

/// Project-root-relative directory the engine files appear under.
pub const RESERVED_DIR: &str = "__codeg";

pub const THREE_WEB_VERSION: &str = "0.4.0";
pub const THREE_VERSION: &str = "0.170.0";

pub struct EngineFile {
    /// Path relative to the project root, always under [`RESERVED_DIR`].
    pub path: &'static str,
    pub bytes: &'static [u8],
    pub content_type: &'static str,
}

const JS: &str = "text/javascript; charset=utf-8";
const MARKDOWN: &str = "text/markdown; charset=utf-8";

/// Where `codeg-platform` is import-mapped to. The file behind it depends on
/// the target (see [`adapter`]).
pub const PLATFORM_ENTRY: &str = "__codeg/platform/current.js";

/// The preview's target. Not a build target: builds leave the Studio.
pub const PREVIEW_TARGET: &str = "studio";

/// Targets a build can be made for, the default first.
pub const BUILD_TARGETS: &[&str] = &["web"];

static FILES: &[EngineFile] = &[
    EngineFile {
        path: "__codeg/engine/three-web/runtime.js",
        bytes: include_bytes!("../engines/three-web/runtime.js"),
        content_type: JS,
    },
    EngineFile {
        path: "__codeg/engine/three-web/ENGINE.md",
        bytes: include_bytes!("../engines/three-web/ENGINE.md"),
        content_type: MARKDOWN,
    },
    EngineFile {
        path: "__codeg/vendor/three.module.min.js",
        bytes: include_bytes!("../engines/vendor/three-0.170.0.module.min.js"),
        content_type: JS,
    },
    EngineFile {
        path: "__codeg/platform/core.js",
        bytes: include_bytes!("../engines/platform/core.js"),
        content_type: JS,
    },
];

/// One adapter per target, each served at [`PLATFORM_ENTRY`].
static ADAPTERS: &[(&str, EngineFile)] = &[
    (
        "studio",
        EngineFile {
            path: PLATFORM_ENTRY,
            bytes: include_bytes!("../engines/platform/studio.js"),
            content_type: JS,
        },
    ),
    (
        "web",
        EngineFile {
            path: PLATFORM_ENTRY,
            bytes: include_bytes!("../engines/platform/web.js"),
            content_type: JS,
        },
    ),
];

/// The `codeg-platform` adapter of a target.
pub fn adapter(target: &str) -> Option<&'static EngineFile> {
    ADAPTERS.iter().find(|(t, _)| *t == target).map(|(_, f)| f)
}

/// What a build for `target` writes next to the game: the runtime, Three.js,
/// the platform layer with that target's adapter. Docs stay out — a build
/// carries only what runs.
pub fn build_files(target: &str) -> Option<Vec<&'static EngineFile>> {
    let adapter = adapter(target)?;
    let mut files: Vec<&'static EngineFile> =
        FILES.iter().filter(|f| f.content_type != MARKDOWN).collect();
    files.push(adapter);
    Some(files)
}

pub fn files() -> &'static [EngineFile] {
    FILES
}

/// The scaffolded copy of the API reference (`outputs/game/ENGINE.md`), so an
/// agent can read the API without the preview server.
pub fn engine_doc() -> &'static str {
    include_str!("../engines/three-web/ENGINE.md")
}

/// Whether `rel` (project-root relative, `/`-separated) is inside the
/// reserved directory — such a path never touches the project folder.
pub fn is_reserved(rel: &str) -> bool {
    let rel = rel.trim_start_matches('/');
    rel == RESERVED_DIR || rel.starts_with("__codeg/")
}

/// The file the preview serves at `rel` — the platform entry is the
/// `studio` adapter.
pub fn lookup(rel: &str) -> Option<&'static EngineFile> {
    let rel = rel.trim_start_matches('/');
    if rel == PLATFORM_ENTRY {
        return adapter(PREVIEW_TARGET);
    }
    FILES.iter().find(|f| f.path == rel)
}

/// Whether a game entry page uses the managed runtime (and therefore needs
/// the engine files next to a packaged build).
pub fn page_uses_managed_engine(html: &str) -> bool {
    html.contains("__codeg/")
}

/// Add `"codeg-platform"` to a page's import map when it maps
/// `codeg-engine` but not the platform, pointing next to the engine
/// (`../../__codeg/…` → `../../__codeg/platform/current.js`). `None` when
/// there is nothing to add. Projects scaffolded before the platform layer
/// keep working without being edited.
pub fn with_platform_import(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let map_start = lower.find("type=\"importmap\"")?;
    let map_end = map_start + lower[map_start..].find("</script")?;
    let map = &html[map_start..map_end];
    if map.contains("\"codeg-platform\"") {
        return None;
    }
    const ENGINE_KEY: &str = "\"codeg-engine\"";
    let key = map_start + map.find(ENGINE_KEY)?;
    let after = &html[key + ENGINE_KEY.len()..map_end];
    let value_start = after.find('"')? + 1;
    let value_len = after[value_start..].find('"')?;
    let value = &after[value_start..value_start + value_len];
    let prefix = &value[..value.find("__codeg/")?];
    let line_start = html[..key].rfind('\n').map_or(0, |i| i + 1);
    let indent = &html[line_start..key];
    let indent = if indent.trim().is_empty() { indent } else { " " };
    let mut out = String::with_capacity(html.len() + 80);
    out.push_str(&html[..key]);
    out.push_str(&format!("\"codeg-platform\": \"{prefix}{PLATFORM_ENTRY}\",\n{indent}"));
    out.push_str(&html[key..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_files_are_consistent() {
        for f in files() {
            assert!(f.path.starts_with("__codeg/"), "{}", f.path);
            assert!(is_reserved(f.path));
            assert!(!f.bytes.is_empty());
        }
        let runtime = std::str::from_utf8(lookup("__codeg/engine/three-web/runtime.js").unwrap().bytes).unwrap();
        assert!(runtime.contains(&format!("export const VERSION = \"{THREE_WEB_VERSION}\"")));
        assert!(runtime.contains("codeg:ready"));
        assert!(engine_doc().contains(THREE_WEB_VERSION));
        let three = lookup("/__codeg/vendor/three.module.min.js").unwrap();
        assert!(std::str::from_utf8(&three.bytes[..200]).unwrap().contains("SPDX-License-Identifier: MIT"));
        assert!(std::str::from_utf8(&three.bytes[..400]).unwrap().contains("\"170\""));
        assert!(lookup("__codeg/nope.js").is_none());
        assert!(!is_reserved("outputs/__codeg/x"));
        assert!(page_uses_managed_engine("<script type=\"importmap\">{\"imports\":{\"three\":\"../../__codeg/vendor/three.module.min.js\"}}"));
    }

    #[test]
    fn platform_entry_is_the_target_adapter() {
        let studio = lookup(PLATFORM_ENTRY).unwrap();
        assert!(std::str::from_utf8(studio.bytes).unwrap().contains("makePlatform(\"studio\""));
        assert!(lookup("__codeg/platform/core.js").is_some());
        for target in BUILD_TARGETS {
            let files = build_files(target).unwrap();
            let entry = files.iter().find(|f| f.path == PLATFORM_ENTRY).unwrap();
            let text = std::str::from_utf8(entry.bytes).unwrap();
            assert!(text.contains(&format!("makePlatform(\"{target}\"")), "{target}");
            assert!(files.iter().any(|f| f.path == "__codeg/platform/core.js"));
            assert!(files.iter().all(|f| !f.path.ends_with(".md")), "docs stay out of a build");
            assert_eq!(files.iter().filter(|f| f.path == PLATFORM_ENTRY).count(), 1);
        }
        assert!(build_files(PREVIEW_TARGET).is_some(), "studio adapter exists");
        assert!(build_files("nope").is_none());
    }

    #[test]
    fn adds_the_platform_to_old_import_maps() {
        let old = "<script type=\"importmap\">\n  {\n    \"imports\": {\n      \"three\": \"../../__codeg/vendor/three.module.min.js\",\n      \"codeg-engine\": \"../../__codeg/engine/three-web/runtime.js\"\n    }\n  }\n</script><script type=\"module\">import \"codeg-engine\"</script>";
        let new = with_platform_import(old).unwrap();
        let json = &new[new.find('{').unwrap()..new.find("</script").unwrap()];
        let map: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(map["imports"]["codeg-platform"], "../../__codeg/platform/current.js");
        assert_eq!(map["imports"]["codeg-engine"], "../../__codeg/engine/three-web/runtime.js");
        assert!(new.contains("\n      \"codeg-platform\""), "keeps the indent");
        assert!(with_platform_import(&new).is_none(), "idempotent");
        // One-line maps and other prefixes.
        let flat = with_platform_import("<script type=\"importmap\">{\"imports\":{\"codeg-engine\":\"./__codeg/engine/three-web/runtime.js\"}}</script>").unwrap();
        assert!(flat.contains("\"codeg-platform\": \"./__codeg/platform/current.js\","));
        // Nothing to do: no import map, or no managed engine in it.
        assert!(with_platform_import("<h1>codeg-engine</h1>").is_none());
        assert!(with_platform_import("<script type=\"importmap\">{\"imports\":{\"three\":\"https://x/three.js\"}}</script>\"codeg-engine\"").is_none());
    }
}
