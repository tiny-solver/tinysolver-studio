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

/// Project-root-relative directory the engine files appear under.
pub const RESERVED_DIR: &str = "__codeg";

pub const THREE_WEB_VERSION: &str = "0.3.0";
pub const THREE_VERSION: &str = "0.170.0";

pub struct EngineFile {
    /// Path relative to the project root, always under [`RESERVED_DIR`].
    pub path: &'static str,
    pub bytes: &'static [u8],
    pub content_type: &'static str,
}

const JS: &str = "text/javascript; charset=utf-8";

static FILES: &[EngineFile] = &[
    EngineFile {
        path: "__codeg/engine/three-web/runtime.js",
        bytes: include_bytes!("../engines/three-web/runtime.js"),
        content_type: JS,
    },
    EngineFile {
        path: "__codeg/engine/three-web/ENGINE.md",
        bytes: include_bytes!("../engines/three-web/ENGINE.md"),
        content_type: "text/markdown; charset=utf-8",
    },
    EngineFile {
        path: "__codeg/vendor/three.module.min.js",
        bytes: include_bytes!("../engines/vendor/three-0.170.0.module.min.js"),
        content_type: JS,
    },
];

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

pub fn lookup(rel: &str) -> Option<&'static EngineFile> {
    let rel = rel.trim_start_matches('/');
    FILES.iter().find(|f| f.path == rel)
}

/// Whether a game entry page uses the managed runtime (and therefore needs
/// the engine files next to a packaged build).
pub fn page_uses_managed_engine(html: &str) -> bool {
    html.contains("__codeg/")
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
}
