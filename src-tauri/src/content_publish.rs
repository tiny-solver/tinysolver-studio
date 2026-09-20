//! Releasing a packaged game from the Studio itself.
//!
//! A build (`build/game/<version>/`) is a self-contained static site. The
//! shortest path from "it works" to "here is a link" is for the Studio's own
//! HTTP server to serve it: publishing registers the build directory under a
//! slug and `/play/<slug>/` answers from it, without authentication — that is
//! the point of a release — and without the preview's error reporter. On a
//! `codeg-server` deployment the link is as public as the server is; on the
//! desktop it is served by the loopback listener (and by the embedded web
//! service when that is on), which is a link for this machine and the LAN.
//!
//! Only directories that were explicitly published are reachable, requests
//! are confined to them with the preview's resolver (no dot-files, no
//! symlink escapes), and the registry lives in the data directory, not in
//! the project, so cloning a project never publishes it.
//!
//! Deploying to an outside host (Cloudflare Pages, Netlify, itch.io, rsync…)
//! is the project's `publish.command` — see
//! [`crate::commands::content_project::publish_content_build`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use serde::{Deserialize, Serialize};

pub const PLAY_PREFIX: &str = "/play";
const REGISTRY_FILE: &str = "published-games.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishedGame {
    pub slug: String,
    /// Project root the build belongs to; one slug per project.
    pub root: String,
    pub version: String,
    /// Absolute build directory being served.
    pub dir: String,
    pub published_at: String,
}

type Registry = BTreeMap<String, PublishedGame>;

/// `$CODEG_HOME`, else `$CODEG_DATA_DIR`, else `~/.tinysolver-studio` — the same
/// precedence the other per-installation stores use.
pub fn registry_path() -> PathBuf {
    if std::env::var_os("CODEG_HOME").filter(|s| !s.is_empty()).is_none() {
        if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
            return PathBuf::from(data).join(REGISTRY_FILE);
        }
    }
    crate::paths::codeg_home_dir().join(REGISTRY_FILE)
}

fn load(registry: &Path) -> Registry {
    std::fs::read_to_string(registry)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save(registry: &Path, games: &Registry) -> std::io::Result<()> {
    if let Some(parent) = registry.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = registry.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(games)?)?;
    std::fs::rename(&tmp, registry)
}

/// URL-safe slug from a project name: lowercase ASCII letters, digits and
/// single dashes. Names with no ASCII at all (a Korean title) become `game`.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').chars().take(48).collect::<String>();
    if out.is_empty() {
        "game".into()
    } else {
        out
    }
}

/// Publish (or re-point) a project's link at a build directory. A project
/// keeps its slug across versions; two projects with the same name get
/// `name` and `name-2`.
pub fn publish_in(
    registry: &Path,
    root: &str,
    name: &str,
    version: &str,
    dir: &str,
) -> std::io::Result<PublishedGame> {
    let mut games = load(registry);
    let slug = games
        .values()
        .find(|g| g.root == root)
        .map(|g| g.slug.clone())
        .unwrap_or_else(|| {
            let base = slugify(name);
            let mut candidate = base.clone();
            let mut n = 2;
            while games.contains_key(&candidate) {
                candidate = format!("{base}-{n}");
                n += 1;
            }
            candidate
        });
    let game = PublishedGame {
        slug: slug.clone(),
        root: root.to_string(),
        version: version.to_string(),
        dir: dir.to_string(),
        published_at: chrono::Local::now().to_rfc3339(),
    };
    games.insert(slug, game.clone());
    save(registry, &games)?;
    Ok(game)
}

/// Take a project's link down. Returns whether there was one.
pub fn unpublish_in(registry: &Path, root: &str) -> std::io::Result<bool> {
    let mut games = load(registry);
    let before = games.len();
    games.retain(|_, g| g.root != root);
    if games.len() == before {
        return Ok(false);
    }
    save(registry, &games)?;
    Ok(true)
}

pub fn published_for_in(registry: &Path, root: &str) -> Option<PublishedGame> {
    load(registry).into_values().find(|g| g.root == root)
}

pub fn play_path(slug: &str) -> String {
    format!("{PLAY_PREFIX}/{slug}/")
}

/// Serve one file of a published build.
pub async fn serve_in(registry: &Path, slug: &str, rel: &str) -> Response {
    let Some(game) = load(registry).remove(slug) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The resolver confines requests by comparing canonical paths.
    let Ok(root) = PathBuf::from(&game.dir).canonicalize() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(path) = crate::content_preview::resolve(&root, rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(crate::content_preview::content_type(&path)),
            );
            // A new version re-points the same URL: always revalidate.
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn handle_bare(AxumPath(slug): AxumPath<String>) -> Response {
    // The build's index.html redirects to a relative entry, which only
    // resolves under a trailing slash.
    Redirect::permanent(&play_path(&slug)).into_response()
}

async fn handle_root(AxumPath(slug): AxumPath<String>) -> Response {
    serve_in(&registry_path(), &slug, "").await
}

async fn handle_file(AxumPath((slug, rest)): AxumPath<(String, String)>) -> Response {
    serve_in(&registry_path(), &slug, &rest).await
}

/// `/play/<slug>/…`, mounted at the root of the web server and of the
/// desktop loopback listener. Public by design.
pub fn routes() -> axum::Router {
    use axum::routing::get;
    axum::Router::new()
        .route(&format!("{PLAY_PREFIX}/{{slug}}"), get(handle_bare))
        .route(&format!("{PLAY_PREFIX}/{{slug}}/"), get(handle_root))
        .route(&format!("{PLAY_PREFIX}/{{slug}}/{{*rest}}"), get(handle_file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_url_safe() {
        assert_eq!(slugify("My Story!"), "my-story");
        assert_eq!(slugify("  --a__b  "), "a-b");
        assert_eq!(slugify("새 게임"), "game");
        assert_eq!(slugify(&"x".repeat(100)).len(), 48);
    }

    #[tokio::test]
    async fn publish_serve_repoint_unpublish() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = tmp.path().join("data/published-games.json");
        let v1 = tmp.path().join("p/build/game/v1");
        let v2 = tmp.path().join("p/build/game/v2");
        for (dir, body) in [(&v1, "one"), (&v2, "two")] {
            std::fs::create_dir_all(dir.join("outputs/game")).unwrap();
            std::fs::write(dir.join("index.html"), body).unwrap();
            std::fs::write(dir.join("outputs/game/index.html"), "<canvas>").unwrap();
            std::fs::write(dir.join(".secret"), "no").unwrap();
        }

        let a = publish_in(&registry, "/p", "My Story", "v1", &v1.to_string_lossy()).unwrap();
        assert_eq!(a.slug, "my-story");
        let other = publish_in(&registry, "/q", "my story", "v1", &v1.to_string_lossy()).unwrap();
        assert_eq!(other.slug, "my-story-2", "same name, another project");

        let body = |r: Response| async move {
            String::from_utf8(axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
        };
        let root = serve_in(&registry, "my-story", "").await;
        assert_eq!(root.status(), StatusCode::OK);
        assert_eq!(root.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(body(root).await, "one");
        let game = serve_in(&registry, "my-story", "outputs/game/index.html").await;
        assert_eq!(body(game).await, "<canvas>", "no preview reporter in a release");

        // Same project, new version: same link.
        let b = publish_in(&registry, "/p", "Renamed", "v2", &v2.to_string_lossy()).unwrap();
        assert_eq!(b.slug, "my-story");
        assert_eq!(body(serve_in(&registry, "my-story", "").await).await, "two");
        assert_eq!(published_for_in(&registry, "/p").unwrap().version, "v2");

        for bad in ["../v1/index.html", ".secret", "/etc/passwd"] {
            assert_eq!(serve_in(&registry, "my-story", bad).await.status(), StatusCode::NOT_FOUND, "{bad}");
        }
        assert_eq!(serve_in(&registry, "nobody", "").await.status(), StatusCode::NOT_FOUND);

        assert!(unpublish_in(&registry, "/p").unwrap());
        assert!(!unpublish_in(&registry, "/p").unwrap());
        assert_eq!(serve_in(&registry, "my-story", "").await.status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_in(&registry, "my-story-2", "").await.status(), StatusCode::OK);
    }
}
