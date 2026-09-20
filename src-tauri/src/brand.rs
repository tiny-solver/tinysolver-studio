//! Single source of truth for everything that distinguishes this build from
//! upstream codeg.
//!
//! This app is a codeg fork, and both are expected to be installed and
//! **running at the same time** on the same machine. Anything named after the
//! product therefore has to differ, or the two processes quietly share state:
//! the same SQLite file, the same rotating log file, the same keyring entries,
//! the same `~/.codeg/` tree. Every such name is declared here once so there is
//! exactly one place to audit when asking "can these two coexist?".
//!
//! What is deliberately **not** namespaced:
//!
//! * `~/.codeg/npm-global` (`process::codeg_npm_prefix`) — the shared install
//!   prefix for agent CLIs. Duplicating it would mean a second multi-hundred-MB
//!   copy of every agent, for no isolation benefit: the CLIs are third-party
//!   tools, not our state.
//! * `codeg-acp` scratch roots and `codeg-delegation-<pid>.sock` — already
//!   per-pid and already written to tolerate a peer instance (see
//!   `acp::scratch_dir`), so a shared namespace is correct there.
//! * The `CODEG_HOME` / `CODEG_DATA_DIR` env var *names* — an operator who
//!   exports those is explicitly pinning a root, and we honour it. Only the
//!   defaults move.

/// Display name: window title, tray tooltip, bundle `productName`.
pub const APP_NAME: &str = "Tinysolver Studio";

/// Bundle identifier, mirroring `tauri.conf.json`. Determines the OS app-data
/// directory (`~/Library/Application Support/<id>` on macOS), so the SQLite
/// database and window state are already isolated from upstream's `app.codeg`.
///
/// Kept in sync manually: the credential-helper subprocess re-derives this path
/// without a Tauri handle (see `git_credential::resolve_app_data_dir`) and must
/// not land in upstream codeg's directory.
pub const BUNDLE_IDENTIFIER: &str = "me.tinysolver.studio";

/// Home-directory state root — preferences, logs, uploads, pets, skills,
/// transcripts. Upstream uses `.codeg`; sharing it would have two processes
/// appending to one rotating log file and racing on `preferences.json`.
pub const HOME_DIR_NAME: &str = ".tinysolver-studio";

/// OS keyring service. Upstream uses `codeg`; sharing it would let either app
/// overwrite the other's GitHub tokens and channel secrets under identical
/// account keys.
pub const KEYRING_SERVICE: &str = "tinysolver-studio";

/// Server-mode data directory basename, used when neither `CODEG_DATA_DIR` nor
/// a Tauri app-data path is available.
pub const DATA_DIR_NAME: &str = "tinysolver-studio";
