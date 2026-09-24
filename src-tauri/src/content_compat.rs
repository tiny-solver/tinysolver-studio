//! "Runs anywhere" check for a packaged game.
//!
//! One build should run in the Studio preview, on a plain web host, inside
//! afterplay's sandboxed iframe (no same-origin, strict CSP) and in the
//! Tauri / Capacitor shells. That holds only while the game keeps a few
//! rules — `ENGINE.md` "어디서든 돌려면" lists them for authors and agents;
//! this module finds the breaks in a build folder.
//!
//! It is a text scan, not a parser: a rule that fires on a comment or a
//! string is cheap to read past, a missed `localStorage` is a blank screen in
//! afterplay. So findings are warnings on a `web` build. A target that
//! cannot run them (afterplay) turns them into errors.

use std::fs;
use std::path::Path;

/// afterplay's bundle limit — the smallest of the targets.
pub const MAX_BUILD_BYTES: u64 = 40 * 1024 * 1024;

/// At most this many findings are reported; the rest are counted.
const MAX_FINDINGS: usize = 40;

/// Rule 2: storage the sandbox refuses. Games save through `codeg-platform`.
const STORAGE: &[&str] = &["localStorage", "sessionStorage", "indexedDB", "document.cookie"];

/// Rule 3: calls a sandboxed iframe has no permission for.
const CALLS: &[&str] = &["alert(", "confirm(", "prompt(", "window.open("];
const ESCAPES: &[&str] = &["serviceWorker", "top.location", "parent.location"];

/// Scan `dir` (a build folder). `__codeg/` is the Studio's own code and is
/// skipped. Returns human-readable findings, `rule · path:line · what`.
pub fn check_build(dir: &Path, total_bytes: u64) -> Vec<String> {
    let mut findings = Vec::new();
    let mut files = Vec::new();
    collect(dir, dir, &mut files);
    files.sort();
    for rel in files {
        let Ok(text) = fs::read_to_string(dir.join(&rel)) else {
            continue;
        };
        check_text(&rel, &text, &mut findings);
    }
    if total_bytes > MAX_BUILD_BYTES {
        findings.push(format!(
            "[5] build is {} MB — afterplay takes up to {} MB",
            total_bytes.div_ceil(1024 * 1024),
            MAX_BUILD_BYTES / (1024 * 1024)
        ));
    }
    if findings.len() > MAX_FINDINGS {
        let more = findings.len() - MAX_FINDINGS;
        findings.truncate(MAX_FINDINGS);
        findings.push(format!("… and {more} more"));
    }
    findings
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if rel == crate::content_engine::RESERVED_DIR {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            collect(root, &path, out);
        } else if kind.is_file() && is_code(&rel) {
            out.push(rel);
        }
    }
}

fn is_code(rel: &str) -> bool {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(ext.as_str(), "js" | "mjs" | "html" | "htm" | "css")
}

fn check_text(rel: &str, text: &str, findings: &mut Vec<String>) {
    for (i, line) in text.lines().enumerate() {
        let code = line.trim_start();
        if code.starts_with("//") || code.starts_with('*') || code.starts_with("/*") {
            continue;
        }
        let at = |what: &str, why: &str| format!("{rel}:{} · {what} — {why}", i + 1);
        if let Some(url) = remote_url(line) {
            findings.push(format!("[1] {}", at(url, "outside network; bundle it under assets/")));
        }
        for name in STORAGE {
            if has_word(line, name) {
                findings.push(format!("[2] {}", at(name, "save through codeg-platform (platform.save / load)")));
            }
        }
        for call in CALLS {
            if has_word(line, call) {
                findings.push(format!("[3] {}", at(call.trim_end_matches('('), "not allowed in a sandboxed iframe; draw it in the scene")));
            }
        }
        for name in ESCAPES {
            if line.contains(name) {
                findings.push(format!("[3] {}", at(name, "not allowed in a sandboxed iframe")));
            }
        }
    }
}

/// An `http(s)://` URL the page would fetch. Namespace URIs (SVG, XHTML)
/// never hit the network and are ignored.
fn remote_url(line: &str) -> Option<&str> {
    for scheme in ["https://", "http://"] {
        let mut from = 0;
        while let Some(pos) = line[from..].find(scheme) {
            let start = from + pos;
            let end = line[start..]
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | '>' | '<'))
                .map_or(line.len(), |n| start + n);
            let url = &line[start..end];
            if !url.starts_with("http://www.w3.org/") {
                return Some(url);
            }
            from = end.max(start + scheme.len());
        }
    }
    None
}

/// `needle` not glued to an identifier on its left (`myalert(` is fine,
/// `window.alert(` and ` alert(` are not).
fn has_word(line: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = line[from..].find(needle) {
        let start = from + pos;
        let before = line[..start].chars().next_back();
        let glued = before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
            || (before == Some('.') && !line[..start].ends_with("window."));
        if !glued {
            return true;
        }
        from = start + needle.len();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_what_breaks_in_a_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("outputs/game/src")).unwrap();
        fs::create_dir_all(root.join("__codeg/platform")).unwrap();
        fs::write(
            root.join("outputs/game/index.html"),
            "<link href=\"https://fonts.googleapis.com/css2?family=X\" rel=stylesheet>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        )
        .unwrap();
        fs::write(
            root.join("outputs/game/src/main.js"),
            [
                "// localStorage in a comment is fine",
                "const best = localStorage.getItem('best')",
                "if (lost) alert('game over')",
                "window.open('https://example.com')",
                "engine.alert('x'); myconfirm(1)",
                "navigator.serviceWorker.register('sw.js')",
                "import { platform } from \"codeg-platform\"",
            ]
            .join("\n"),
        )
        .unwrap();
        // The Studio's own files are not the game's problem.
        fs::write(root.join("__codeg/platform/core.js"), "window.localStorage").unwrap();

        let found = check_build(root, 1024);
        let text = found.join("\n");
        assert!(text.contains("[1] outputs/game/index.html:1 · https://fonts.googleapis.com/css2?family=X"), "{text}");
        assert!(!text.contains("w3.org"), "{text}");
        assert!(text.contains("[2] outputs/game/src/main.js:2 · localStorage"), "{text}");
        assert!(text.contains("[3] outputs/game/src/main.js:3 · alert"), "{text}");
        assert!(text.contains("[3] outputs/game/src/main.js:4 · window.open"), "{text}");
        assert!(text.contains("[1] outputs/game/src/main.js:4 · https://example.com"), "{text}");
        assert!(text.contains("[3] outputs/game/src/main.js:6 · serviceWorker"), "{text}");
        assert!(!text.contains("main.js:1 "), "comment skipped: {text}");
        assert!(!text.contains("main.js:5 "), "engine.alert / myconfirm are not the browser's: {text}");
        assert!(!text.contains("main.js:7 "), "{text}");
        assert!(!text.contains("__codeg"), "{text}");
        assert_eq!(found.len(), 6, "{text}");

        let big = check_build(root, MAX_BUILD_BYTES + 1);
        assert!(big.last().unwrap().starts_with("[5] build is 41 MB"), "{big:?}");
    }

    #[test]
    fn a_clean_build_has_nothing_to_say() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("outputs/game")).unwrap();
        fs::write(dir.path().join("outputs/game/index.html"), "<script type=module src=./src/main.js></script>").unwrap();
        assert!(check_build(dir.path(), 10).is_empty());
    }
}
