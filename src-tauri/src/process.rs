use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn configure_std_command(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
        set_utf8_env(command);
    }

    command
}

pub fn std_command<S>(program: S) -> Command
where
    S: AsRef<OsStr>,
{
    let mut command = Command::new(normalized_program(program));
    configure_std_command(&mut command);
    command
}

pub fn configure_tokio_command(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
        set_utf8_env(command);
    }

    command
}

/// Hint child processes to produce UTF-8 output on Windows.
///
/// Sets environment variables recognised by common runtimes (Python, MSYS2/Git
/// Bash, .NET console apps).  Not all programs honour these, but they cover the
/// most frequent sources of mojibake in practice.
#[cfg(windows)]
fn set_utf8_env<C: SetEnv>(command: &mut C) {
    // Python
    command.env("PYTHONUTF8", "1");
    command.env("PYTHONIOENCODING", "utf-8");
    // MSYS2 / Git-for-Windows / POSIX-layer tools
    command.env("LANG", "C.UTF-8");
    command.env("LC_ALL", "C.UTF-8");
}

/// Abstraction over the `.env()` method shared by std and tokio Command types.
#[cfg(windows)]
trait SetEnv {
    fn env(&mut self, key: &str, val: &str) -> &mut Self;
}

#[cfg(windows)]
impl SetEnv for Command {
    fn env(&mut self, key: &str, val: &str) -> &mut Self {
        Command::env(self, key, val)
    }
}

#[cfg(windows)]
impl SetEnv for tokio::process::Command {
    fn env(&mut self, key: &str, val: &str) -> &mut Self {
        tokio::process::Command::env(self, key, val)
    }
}

#[cfg(windows)]
fn maybe_windows_cmd_shim(program: &OsStr) -> Option<OsString> {
    let path = Path::new(program);
    if path.components().count() != 1 || path.extension().is_some() {
        return None;
    }

    let raw = program.to_string_lossy();
    let normalized = raw.to_ascii_lowercase();
    let needs_cmd_shim = matches!(
        normalized.as_str(),
        "npm" | "npx" | "pnpm" | "pnpx" | "yarn" | "yarnpkg" | "corepack"
    );

    if needs_cmd_shim {
        Some(OsString::from(format!("{raw}.cmd")))
    } else {
        None
    }
}

pub fn normalized_program<S>(program: S) -> OsString
where
    S: AsRef<OsStr>,
{
    #[cfg(windows)]
    {
        if let Some(shimmed) = maybe_windows_cmd_shim(program.as_ref()) {
            return shimmed;
        }
    }

    program.as_ref().to_os_string()
}

pub fn tokio_command<S>(program: S) -> tokio::process::Command
where
    S: AsRef<OsStr>,
{
    let mut command = tokio::process::Command::new(normalized_program(program));
    configure_tokio_command(&mut command);
    command
}

/// If `node` is not already in PATH, detect common Node.js version manager
/// installations and prepend the best matching bin directory to the process
/// PATH so that **all** downstream code (`which`, `Command`, child processes)
/// can find node/npm/npx without any special handling.
///
/// Only ONE directory is ever added (the first candidate that contains a
/// real `node` binary), so PATH pollution is minimal.
///
/// # Call site requirements
///
/// * Call **once** at startup, **before** any multi-threaded work begins.
///   `std::env::set_var` is not thread-safe (`unsafe` in Rust edition 2024);
///   calling it while other threads may read `PATH` is a data race.
/// * In the Tauri desktop binary: call from `run()` before `tauri::Builder`.
/// * In the standalone server binary: call from `main()` before `#[tokio::main]`.
/// * In Docker / systemd services: typically a no-op — `which("node")`
///   succeeds because `node` is installed to a standard PATH directory.
pub fn ensure_node_in_path() {
    // Already reachable — nothing to do.
    if which::which("node").is_ok() {
        return;
    }

    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            eprintln!("[PATH] node not in PATH and HOME not set; cannot search for Node.js");
            return;
        }
    };

    if let Some(bin_dir) = find_node_bin_dir(&home) {
        prepend_to_path(&bin_dir);
        eprintln!("[PATH] node not in PATH, prepended {}", bin_dir.display());
    }
}

/// Search common Node.js version manager directories for a `node` binary and
/// return the containing bin directory.
///
/// Supported version managers / installation methods:
/// - **nvm** (Unix) — `$NVM_DIR` or `~/.nvm`
/// - **nvm-windows** — `%NVM_SYMLINK%`, `%NVM_HOME%` or `%APPDATA%\nvm`
/// - **fnm** (cross-platform) — `$FNM_MULTISHELL_PATH`, `$FNM_DIR` or platform default
/// - **volta** (cross-platform) — `$VOLTA_HOME` or `~/.volta`
/// - **asdf** (Unix) — `$ASDF_DATA_DIR` or `~/.asdf`
/// - **mise / rtx** (cross-platform) — `$MISE_DATA_DIR` or platform default
/// - **n** (Unix) — `$N_PREFIX` or `/usr/local`
/// - **Homebrew** (macOS) — `/opt/homebrew/opt/node` or `/usr/local/opt/node`
/// - **Scoop** (Windows) — `%SCOOP%\apps\nodejs*\current`
fn find_node_bin_dir(home: &std::path::Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };

    // ── nvm (Unix) ───────────────────────────────────────────────────────
    // Standard nvm for macOS/Linux. nvm-windows is a separate tool (below).
    if cfg!(not(windows)) {
        let nvm_dir = std::env::var("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".nvm"));
        if nvm_dir.is_dir() {
            let versions_dir = nvm_dir.join("versions").join("node");
            let mut alias_matched = false;

            // Try to match the "default" alias to a concrete version.
            // The alias may be a partial version (e.g. "18", "20.11"), a full
            // version, or a symbolic name ("lts/*", "lts/hydrogen", "node").
            // We only attempt matching for numeric prefixes — symbolic aliases
            // require full nvm resolution which we cannot replicate here.
            let default_alias = nvm_dir.join("alias").join("default");
            if let Ok(raw_alias) = std::fs::read_to_string(&default_alias) {
                let alias = raw_alias.trim();
                let is_numeric = alias
                    .trim_start_matches('v')
                    .starts_with(|c: char| c.is_ascii_digit());
                if is_numeric {
                    let alias_stripped = alias.trim_start_matches('v');
                    if let Ok(entries) = std::fs::read_dir(&versions_dir) {
                        for entry in entries.flatten() {
                            let name = entry.file_name().to_string_lossy().to_string();
                            let stripped = name.trim_start_matches('v');
                            if stripped.starts_with(alias_stripped) {
                                candidates.push(entry.path().join("bin"));
                                alias_matched = true;
                            }
                        }
                    }
                }
            }

            // Fall back: all installed versions, newest first.
            // Skipped when alias resolution already produced candidates.
            // NOTE: lexicographic sort is imperfect for semver (v8 > v18),
            // but acceptable for a best-effort heuristic.
            if !alias_matched {
                if let Ok(mut entries) = std::fs::read_dir(&versions_dir)
                    .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
                {
                    entries.sort();
                    entries.reverse();
                    for entry in entries {
                        candidates.push(entry.join("bin"));
                    }
                }
            }
        }
    }

    // ── nvm-windows ──────────────────────────────────────────────────────
    // nvm-windows is a completely separate tool from Unix nvm with a
    // different directory layout: %NVM_HOME%\v<version>\node.exe (no bin/).
    // The active version is symlinked at %NVM_SYMLINK%.
    if cfg!(windows) {
        // The active symlinked version directory (e.g. C:\Program Files\nodejs)
        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            let symlink_path = PathBuf::from(&nvm_symlink);
            if symlink_path.is_dir() {
                candidates.push(symlink_path);
            }
        }

        // All installed versions, newest first (lexicographic — see note
        // in the nvm section about semver edge cases).
        let nvm_home = std::env::var("NVM_HOME")
            .map(PathBuf::from)
            .or_else(|_| {
                std::env::var("APPDATA").map(|appdata| PathBuf::from(appdata).join("nvm"))
            });
        if let Ok(nvm_home) = nvm_home {
            if nvm_home.is_dir() {
                if let Ok(mut entries) = std::fs::read_dir(&nvm_home).map(|rd| {
                    rd.flatten()
                        .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                        .filter(|e| e.file_name().to_string_lossy().starts_with('v'))
                        .map(|e| e.path())
                        .collect::<Vec<_>>()
                }) {
                    entries.sort();
                    entries.reverse();
                    // nvm-windows places node.exe directly in the version dir
                    candidates.extend(entries);
                }
            }
        }
    }

    // ── fnm ──────────────────────────────────────────────────────────────
    // FNM_MULTISHELL_PATH is set by `eval "$(fnm env)"` in the user's
    // shell RC. It points to a temporary directory that only exists during
    // an active shell session. In a GUI app (Tauri) this is typically
    // NOT set because the process inherits from the window manager, not a
    // shell. It mainly helps the *server binary* launched from a terminal.
    if let Ok(fnm_multishell_path) = std::env::var("FNM_MULTISHELL_PATH") {
        let path = PathBuf::from(fnm_multishell_path);
        if path.is_dir() {
            candidates.push(path);
        }
    }

    // Platform-specific default for FNM_DIR:
    //   Unix: $XDG_DATA_HOME/fnm or ~/.local/share/fnm
    //   Windows: %APPDATA%/fnm
    let fnm_dir = std::env::var("FNM_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        if cfg!(windows) {
            std::env::var("APPDATA")
                .map(|appdata| PathBuf::from(appdata).join("fnm"))
                .unwrap_or_else(|_| home.join(".fnm"))
        } else {
            std::env::var("XDG_DATA_HOME")
                .map(|xdg| PathBuf::from(xdg).join("fnm"))
                .unwrap_or_else(|_| home.join(".local").join("share").join("fnm"))
        }
    });
    let fnm_versions = fnm_dir.join("node-versions");
    if fnm_versions.is_dir() {
        if let Ok(mut entries) = std::fs::read_dir(&fnm_versions)
            .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
        {
            entries.sort();
            entries.reverse();
            for entry in entries {
                let installation = entry.join("installation");
                // On Unix fnm places binaries under installation/bin;
                // on Windows they sit directly in the installation dir.
                let bin = installation.join("bin");
                candidates.push(if bin.is_dir() { bin } else { installation });
            }
        }
    }

    // ── volta ────────────────────────────────────────────────────────────
    // Volta's bin/ directory contains *shims* — they exist even if no Node
    // version has been installed (`volta install node`).  Only add the
    // shim directory when at least one concrete Node image is present,
    // otherwise downstream `node` invocations would get a cryptic Volta
    // error instead of a clean "node not found".
    let volta_home = std::env::var("VOLTA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".volta"));
    let volta_node_images = volta_home.join("tools").join("image").join("node");
    let has_volta_node = volta_node_images
        .is_dir()
        .then(|| std::fs::read_dir(&volta_node_images).ok())
        .flatten()
        .is_some_and(|mut rd| rd.next().is_some());
    if has_volta_node {
        let volta_bin = volta_home.join("bin");
        if volta_bin.is_dir() {
            candidates.push(volta_bin);
        }
    }

    // ── asdf (Unix) ──────────────────────────────────────────────────────
    // asdf does not officially support Windows.
    if cfg!(not(windows)) {
        let asdf_dir = std::env::var("ASDF_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".asdf"));
        let asdf_nodejs = asdf_dir.join("installs").join("nodejs");
        if asdf_nodejs.is_dir() {
            if let Ok(mut entries) = std::fs::read_dir(&asdf_nodejs)
                .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
            {
                entries.sort();
                entries.reverse();
                for entry in entries {
                    candidates.push(entry.join("bin"));
                }
            }
        }
    }

    // ── mise / rtx (cross-platform) ─────────────────────────────────────
    // mise respects MISE_DATA_DIR > XDG_DATA_HOME > platform data dir.
    let mise_dir = std::env::var("MISE_DATA_DIR")
        .or_else(|_| std::env::var("XDG_DATA_HOME").map(|xdg| format!("{}/mise", xdg)))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| home.join(".local").join("share"))
                .join("mise")
        });
    let mise_node = mise_dir.join("installs").join("node");
    if mise_node.is_dir() {
        if let Ok(mut entries) = std::fs::read_dir(&mise_node)
            .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
        {
            entries.sort();
            entries.reverse();
            for entry in entries {
                // mise on Unix places binaries under <version>/bin/;
                // on Windows they may sit directly in the version dir.
                let bin = entry.join("bin");
                candidates.push(if bin.is_dir() { bin } else { entry });
            }
        }
    }

    // ── n (Unix) ─────────────────────────────────────────────────────────
    // `n` stores versions under $N_PREFIX/n/versions/node/<version>/bin/.
    if cfg!(not(windows)) {
        let n_prefix = std::env::var("N_PREFIX")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/usr/local"));
        let n_versions = n_prefix.join("n").join("versions").join("node");
        if n_versions.is_dir() {
            if let Ok(mut entries) = std::fs::read_dir(&n_versions)
                .map(|rd| rd.flatten().map(|e| e.path()).collect::<Vec<_>>())
            {
                entries.sort();
                entries.reverse();
                for entry in entries {
                    candidates.push(entry.join("bin"));
                }
            }
        }
    }

    // ── Homebrew (macOS) ─────────────────────────────────────────────────
    if cfg!(target_os = "macos") {
        // Apple Silicon (/opt/homebrew) and Intel (/usr/local)
        for prefix in &["/opt/homebrew", "/usr/local"] {
            let brew_node = PathBuf::from(prefix).join("opt").join("node").join("bin");
            if brew_node.is_dir() {
                candidates.push(brew_node);
            }
        }
    }

    // ── Scoop (Windows) ─────────────────────────────────────────────────
    if cfg!(windows) {
        let scoop_dir = std::env::var("SCOOP")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("scoop"));
        // Scoop may install as "nodejs-lts" or "nodejs".
        for app_name in &["nodejs-lts", "nodejs"] {
            let scoop_node = scoop_dir.join("apps").join(app_name).join("current");
            if scoop_node.is_dir() {
                candidates.push(scoop_node);
            }
        }
    }

    // Return the first candidate that actually contains a `node` binary.
    candidates.into_iter().find(|dir| dir.join(node_bin).is_file())
}

/// Prepend a directory to the process `PATH` environment variable.
pub(crate) fn prepend_to_path(dir: &std::path::Path) {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut new_path = OsString::from(dir);
    new_path.push(sep);
    new_path.push(current);
    std::env::set_var("PATH", new_path);
}

/// Return the user-local npm prefix directory (`~/.codeg/npm-global/`).
///
/// Used as a fallback when `npm install -g` fails with EACCES because the
/// system global prefix (e.g. `/usr/local/lib/node_modules/`) is not writable.
pub(crate) fn user_npm_prefix() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codeg").join("npm-global"))
}

/// Ensure the user-local npm prefix `bin/` directory is in `PATH` so that
/// binaries installed via the EACCES fallback can be found by `which` and
/// child processes.  Safe to call even if the directory does not exist yet.
///
/// On Unix, `npm install -g --prefix=<p>` places binaries in `<p>/bin/`.
/// On Windows, binaries are placed directly in `<p>/`.
pub fn ensure_user_npm_prefix_in_path() {
    if let Some(prefix) = user_npm_prefix() {
        let bin_dir = if cfg!(windows) {
            prefix
        } else {
            prefix.join("bin")
        };
        // Avoid adding duplicates.
        let current = std::env::var_os("PATH").unwrap_or_default();
        let bin_str = bin_dir.to_string_lossy();
        let sep = if cfg!(windows) { ";" } else { ":" };
        if !current
            .to_string_lossy()
            .split(sep)
            .any(|p| p == bin_str.as_ref())
        {
            prepend_to_path(&bin_dir);
        }
    }
}
