//! `model_once` — one call to a subscription coding CLI, shaped by a schema.
//!
//! The Studio does not hold model keys (studio-layers ①): a one-shot model
//! step runs the machine's own `claude` (`claude -p`) or `codex`
//! (`codex exec`), logged in with the owner's subscription. The caller gives
//! the agent, a prompt, picture files to attach, the JSON Schema the answer
//! must have and optionally a model; the outcome is the parsed answer, checked
//! against that schema here as well — the CLIs' structured output is the
//! first line of defence, not the only one.
//!
//! The call is a pure part: no session is kept, the user's hooks, CLAUDE.md
//! and MCP servers stay out (`--safe-mode`, `--ephemeral`), the only tool is
//! reading the attached pictures, and it runs in a scratch folder.
//!
//! Outcomes follow the studio rule: `{ ok: true, output, ... }`, or
//! `{ ok: false, note }` the LLM reads and acts on — a missing CLI, a timeout,
//! an answer that is not JSON or does not fit the schema.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Longest a call may take unless the request says otherwise.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_TIMEOUT_SECS: u64 = 30 * 60;
/// How much of a CLI's own output a failure note quotes.
const NOTE_TAIL_LINES: usize = 15;

/// Which CLI answers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelAgent {
    Claude,
    Codex,
}

impl ModelAgent {
    fn bin(self) -> &'static str {
        match self {
            ModelAgent::Claude => "claude",
            ModelAgent::Codex => "codex",
        }
    }

    /// The env var that names the binary explicitly (a service's PATH rarely
    /// has the user's node or `~/.local/bin`).
    fn env_var(self) -> &'static str {
        match self {
            ModelAgent::Claude => "STUDIO_CLAUDE_BIN",
            ModelAgent::Codex => "STUDIO_CODEX_BIN",
        }
    }
}

/// What `model_once` is asked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelOnceRequest {
    pub agent: ModelAgent,
    pub prompt: String,
    /// Picture files to attach, absolute or relative to the project.
    #[serde(default)]
    pub images: Vec<String>,
    /// JSON Schema of the answer — an object schema.
    pub schema: Value,
    /// The CLI's model name (`sonnet`, `gpt-5.5` …). `None` — the CLI's default.
    #[serde(default)]
    pub model: Option<String>,
    /// Seconds before the call is stopped. Default 300, at most 1800.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

/// Run one call. `root` is the project the image paths are relative to.
pub async fn run(root: &Path, req: ModelOnceRequest) -> Value {
    if req.prompt.trim().is_empty() {
        return fail("prompt is empty.");
    }
    let validator = match compile_schema(&req.schema) {
        Ok(v) => v,
        Err(note) => return fail(note),
    };
    let images = match resolve_images(root, &req.images) {
        Ok(i) => i,
        Err(note) => return fail(note),
    };
    let Some(bin) = find_cli(req.agent) else {
        return fail(format!(
            "`{}` was not found on this computer. Install it and log in with the subscription \
             (`{}`), or set {} to its path.",
            req.agent.bin(),
            match req.agent {
                ModelAgent::Claude => "claude auth login",
                ModelAgent::Codex => "codex login",
            },
            req.agent.env_var(),
        ));
    };
    let timeout = req
        .timeout_secs
        .map(|s| Duration::from_secs(s.clamp(1, MAX_TIMEOUT_SECS)))
        .unwrap_or(DEFAULT_TIMEOUT);
    let work = match tempfile::tempdir() {
        Ok(w) => w,
        Err(e) => return fail(format!("Could not make a temporary folder: {e}")),
    };
    let started = Instant::now();
    let answer = match req.agent {
        ModelAgent::Claude => call_claude(&bin, work.path(), &req, &images, timeout).await,
        ModelAgent::Codex => call_codex(&bin, work.path(), &req, &images, timeout).await,
    };
    let Answer {
        output,
        model,
        cost_usd,
        usage,
    } = match answer {
        Ok(a) => a,
        Err(note) => return fail(note),
    };
    let errors: Vec<String> = validator
        .iter_errors(&output)
        .take(10)
        .map(|e| {
            let at = e.instance_path().to_string();
            if at.is_empty() {
                e.to_string()
            } else {
                format!("{at}: {e}")
            }
        })
        .collect();
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "note": format!(
                "{} answered, but the answer does not fit the schema:\n- {}",
                req.agent.bin(),
                errors.join("\n- ")
            ),
            "output": output,
        });
    }
    json!({
        "ok": true,
        "agent": req.agent,
        "model": model.or(req.model),
        "output": output,
        "duration_ms": started.elapsed().as_millis() as u64,
        "cost_usd": cost_usd,
        "usage": usage,
        "cli": bin.to_string_lossy(),
    })
}

struct Answer {
    output: Value,
    model: Option<String>,
    cost_usd: Option<f64>,
    /// Token counts as the CLI reports them: claude's `usage` object,
    /// codex's `{ "total_tokens": n }`.
    usage: Option<Value>,
}

fn compile_schema(schema: &Value) -> Result<jsonschema::Validator, String> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err("schema must be a JSON Schema with \"type\": \"object\" (both CLIs answer with an object).".into());
    }
    jsonschema::validator_for(schema).map_err(|e| format!("schema is not a valid JSON Schema: {e}"))
}

fn resolve_images(root: &Path, images: &[String]) -> Result<Vec<PathBuf>, String> {
    images
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let abs = if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            };
            if !abs.is_file() {
                return Err(format!("image {p} is not a file ({}).", abs.display()));
            }
            abs.canonicalize().map_err(|e| format!("image {p}: {e}"))
        })
        .collect()
}

/// `$STUDIO_<AGENT>_BIN`, then `PATH`, then where the installers put it —
/// a service (codeg-server under systemd) does not get the login shell's PATH.
fn find_cli(agent: ModelAgent) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(agent.env_var()).filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if let Ok(p) = which::which(agent.bin()) {
        return Some(p);
    }
    let home = dirs::home_dir()?;
    known_places(&home, agent).into_iter().find(|p| p.is_file())
}

fn known_places(home: &Path, agent: ModelAgent) -> Vec<PathBuf> {
    let name = if cfg!(windows) {
        format!("{}.cmd", agent.bin())
    } else {
        agent.bin().to_string()
    };
    let mut places = vec![
        home.join(".local/bin").join(&name),
        PathBuf::from("/opt/homebrew/bin").join(&name),
        PathBuf::from("/usr/local/bin").join(&name),
        home.join(".npm-global/bin").join(&name),
    ];
    // nvm: newest node first.
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nodes: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        nodes.sort_by_key(|p| std::cmp::Reverse(node_version(p)));
        places.extend(nodes.into_iter().map(|n| n.join("bin").join(&name)));
    }
    places
}

fn node_version(dir: &Path) -> Vec<u64> {
    dir.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .split('.')
        .map(|s| s.parse().unwrap_or(0))
        .collect()
}

/// The CLI's own folder first on the child's PATH: the npm shims are
/// `#!/usr/bin/env node` scripts with node beside them.
fn child_path(bin: &Path) -> Option<OsString> {
    let dir = bin.parent()?;
    let mut paths = vec![dir.to_path_buf()];
    if let Some(cur) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&cur));
    }
    std::env::join_paths(paths).ok()
}

fn command(bin: &Path, cwd: &Path) -> tokio::process::Command {
    let mut cmd = crate::process::tokio_command(bin);
    cmd.current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(path) = child_path(bin) {
        cmd.env("PATH", path);
    }
    cmd
}

async fn output_within(
    mut cmd: tokio::process::Command,
    timeout: Duration,
    who: &str,
) -> Result<std::process::Output, String> {
    match tokio::time::timeout(timeout, cmd.output()).await {
        Err(_) => Err(format!(
            "{who} did not answer within {} s and was stopped.",
            timeout.as_secs()
        )),
        Ok(Err(e)) => Err(format!("Could not start {who}: {e}")),
        Ok(Ok(o)) => Ok(o),
    }
}

fn attach_note(images: &[PathBuf]) -> String {
    if images.is_empty() {
        return String::new();
    }
    let list: Vec<String> = images
        .iter()
        .map(|p| format!("- {}", p.display()))
        .collect();
    format!(
        "\n\nAttached images (read each with the Read tool before answering):\n{}",
        list.join("\n")
    )
}

async fn call_claude(
    bin: &Path,
    work: &Path,
    req: &ModelOnceRequest,
    images: &[PathBuf],
    timeout: Duration,
) -> Result<Answer, String> {
    let mut cmd = command(bin, work);
    cmd.arg("-p")
        .arg(format!("{}{}", req.prompt, attach_note(images)))
        .args([
            "--output-format",
            "json",
            "--no-session-persistence",
            "--safe-mode",
        ])
        .arg("--json-schema")
        .arg(req.schema.to_string());
    if images.is_empty() {
        cmd.args(["--tools", ""]);
    } else {
        cmd.args(["--tools", "Read", "--allowedTools", "Read"]);
        for dir in parent_dirs(images) {
            cmd.arg("--add-dir").arg(dir);
        }
    }
    if let Some(m) = &req.model {
        cmd.arg("--model").arg(m);
    }
    let out = output_within(cmd, timeout, "claude").await?;
    parse_claude(&out.stdout, &out.stderr, out.status.success())
}

fn parse_claude(stdout: &[u8], stderr: &[u8], success: bool) -> Result<Answer, String> {
    let result: Option<Value> = serde_json::from_slice(stdout).ok();
    let Some(result) = result.filter(Value::is_object) else {
        return Err(format!(
            "claude did not return its JSON result.\n{}",
            log_tail(stdout, stderr)
        ));
    };
    if result["is_error"] == true || !success {
        let why = result["result"].as_str().unwrap_or("").trim();
        let why = if why.is_empty() {
            log_tail(stdout, stderr)
        } else {
            why.to_string()
        };
        return Err(format!(
            "claude failed ({}). If it is not logged in, run `claude auth login` on this machine.\n{why}",
            result["subtype"].as_str().unwrap_or("error")
        ));
    }
    // `structured_output` when --json-schema took; the text as a fallback.
    let output = match &result["structured_output"] {
        Value::Null => {
            parse_json_text(result["result"].as_str().unwrap_or("")).ok_or_else(|| {
                format!(
                    "claude answered without JSON:\n{}",
                    result["result"].as_str().unwrap_or("")
                )
            })?
        }
        v => v.clone(),
    };
    let model = result["modelUsage"]
        .as_object()
        .and_then(|m| m.keys().next().cloned());
    Ok(Answer {
        output,
        model,
        cost_usd: result["total_cost_usd"].as_f64(),
        usage: result.get("usage").filter(|u| u.is_object()).cloned(),
    })
}

async fn call_codex(
    bin: &Path,
    work: &Path,
    req: &ModelOnceRequest,
    images: &[PathBuf],
    timeout: Duration,
) -> Result<Answer, String> {
    let schema_path = work.join("schema.json");
    let last = work.join("last-message.txt");
    tokio::fs::write(&schema_path, req.schema.to_string())
        .await
        .map_err(|e| format!("Could not write the schema file: {e}"))?;
    let mut cmd = command(bin, work);
    cmd.arg("exec")
        .args([
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ])
        .arg("--cd")
        .arg(work)
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("--output-last-message")
        .arg(&last);
    if let Some(m) = &req.model {
        cmd.arg("--model").arg(m);
    }
    for img in images {
        cmd.arg("--image").arg(img);
    }
    // `--image` takes several values: `--` keeps the prompt out of it.
    cmd.arg("--").arg(&req.prompt);
    let out = output_within(cmd, timeout, "codex").await?;
    let text = tokio::fs::read_to_string(&last).await.unwrap_or_default();
    if !out.status.success() || text.trim().is_empty() {
        return Err(format!(
            "codex failed (exit {}). If it is not logged in, run `codex login` on this machine.\n{}",
            out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
            log_tail(&out.stdout, &out.stderr)
        ));
    }
    let output = parse_json_text(&text)
        .ok_or_else(|| format!("codex answered without JSON:\n{}", text.trim()))?;
    let usage = codex_tokens(&out.stdout, &out.stderr).map(|n| json!({ "total_tokens": n }));
    Ok(Answer {
        output,
        model: req.model.clone(),
        cost_usd: None,
        usage,
    })
}

/// codex exec ends its log with `tokens used` and the count on the next line.
fn codex_tokens(stdout: &[u8], stderr: &[u8]) -> Option<u64> {
    let log = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let mut lines = log.lines().map(str::trim).filter(|l| !l.is_empty());
    while let Some(l) = lines.next() {
        if l == "tokens used" {
            return lines.next()?.replace(',', "").parse().ok();
        }
    }
    None
}

fn parent_dirs(images: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = images
        .iter()
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

/// The answer text as JSON: the whole text, else a fenced ```json block.
fn parse_json_text(text: &str) -> Option<Value> {
    let text = text.trim();
    if let Ok(v) = serde_json::from_str(text) {
        return Some(v);
    }
    let start = text.find("```")?;
    let body = &text[start + 3..];
    let body = body.strip_prefix("json").unwrap_or(body);
    let end = body.find("```")?;
    serde_json::from_str(body[..end].trim()).ok()
}

fn log_tail(stdout: &[u8], stderr: &[u8]) -> String {
    let log = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let lines: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(NOTE_TAIL_LINES)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "style": { "type": "string" },
                "colors": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["style", "colors"],
            "additionalProperties": false
        })
    }

    #[test]
    fn request_parses_with_defaults() {
        let req: ModelOnceRequest = serde_json::from_value(json!({
            "agent": "codex", "prompt": "hi", "schema": style_schema()
        }))
        .unwrap();
        assert_eq!(req.agent, ModelAgent::Codex);
        assert!(req.images.is_empty() && req.model.is_none() && req.timeout_secs.is_none());
        assert!(serde_json::from_value::<ModelOnceRequest>(json!({
            "agent": "gemini", "prompt": "hi", "schema": style_schema()
        }))
        .is_err());
    }

    #[test]
    fn schema_must_be_an_object_schema() {
        assert!(compile_schema(&style_schema()).is_ok());
        assert!(compile_schema(&json!({ "type": "string" })).is_err());
        assert!(compile_schema(&json!({ "type": "object", "properties": 3 })).is_err());
    }

    #[test]
    fn claude_structured_output_is_taken() {
        let out = json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "{\"style\":\"x\",\"colors\":[]}",
            "structured_output": { "style": "flat", "colors": ["red"] },
            "total_cost_usd": 0.01,
            "modelUsage": { "claude-sonnet-5-5": {} }
        });
        let a = parse_claude(out.to_string().as_bytes(), b"", true).unwrap();
        assert_eq!(a.output, json!({ "style": "flat", "colors": ["red"] }));
        assert_eq!(a.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(a.cost_usd, Some(0.01));
    }

    #[test]
    fn claude_error_and_garbage_are_notes() {
        let out = json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "result": "Not logged in" });
        let note = parse_claude(out.to_string().as_bytes(), b"", false)
            .err()
            .unwrap();
        assert!(
            note.contains("Not logged in") && note.contains("claude auth login"),
            "{note}"
        );
        let note = parse_claude(b"boom", b"segfault", false).err().unwrap();
        assert!(note.contains("segfault"), "{note}");
    }

    #[test]
    fn codex_token_count_is_read() {
        assert_eq!(
            codex_tokens(b"{}", b"codex\n{}\ntokens used\n17,583\n"),
            Some(17583)
        );
        assert_eq!(codex_tokens(b"", b"nothing"), None);
    }

    #[test]
    fn json_text_plain_or_fenced() {
        assert_eq!(parse_json_text(" {\"a\":1} "), Some(json!({ "a": 1 })));
        assert_eq!(
            parse_json_text("here:\n```json\n{\"a\":2}\n```\n"),
            Some(json!({ "a": 2 }))
        );
        assert_eq!(parse_json_text("no json"), None);
    }

    #[test]
    fn validation_catches_a_wrong_shape() {
        let v = compile_schema(&style_schema()).unwrap();
        assert!(v.is_valid(&json!({ "style": "s", "colors": ["a"] })));
        assert!(!v.is_valid(&json!({ "style": "s", "colors": "red" })));
        assert!(!v.is_valid(&json!({ "style": "s", "colors": [], "extra": 1 })));
    }

    #[test]
    fn images_resolve_against_the_project() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.png"), b"x").unwrap();
        let got = resolve_images(dir.path(), &["a.png".into()]).unwrap();
        assert_eq!(got[0], dir.path().join("a.png").canonicalize().unwrap());
        assert!(resolve_images(dir.path(), &["missing.png".into()]).is_err());
    }

    #[test]
    fn nvm_places_newest_node_first() {
        let home = tempfile::tempdir().unwrap();
        for v in ["v20.19.6", "v24.18.0", "v9.0.0"] {
            std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(v).join("bin"))
                .unwrap();
        }
        let places = known_places(home.path(), ModelAgent::Codex);
        let nvm: Vec<String> = places
            .iter()
            .filter(|p| p.to_string_lossy().contains(".nvm"))
            .map(|p| {
                p.parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(nvm, ["v24.18.0", "v20.19.6", "v9.0.0"]);
    }

    /// The real thing, on this machine's logged-in CLIs:
    /// `STUDIO_MODEL_ONCE_IMAGE=/path/pic.png cargo test … live_both_agents -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "calls claude and codex with the owner's subscription"]
    async fn live_both_agents() {
        let image = std::env::var("STUDIO_MODEL_ONCE_IMAGE").expect("STUDIO_MODEL_ONCE_IMAGE");
        let root = std::env::temp_dir();
        for agent in [ModelAgent::Claude, ModelAgent::Codex] {
            let out = run(
                &root,
                ModelOnceRequest {
                    agent,
                    prompt: "Describe this picture as JSON {style, colors[]}.".into(),
                    images: vec![image.clone()],
                    schema: style_schema(),
                    model: None,
                    timeout_secs: None,
                },
            )
            .await;
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
            assert_eq!(out["ok"], true, "{agent:?}: {out}");
        }
    }

    #[tokio::test]
    async fn bad_requests_fail_before_any_cli_runs() {
        let dir = tempfile::tempdir().unwrap();
        let base = ModelOnceRequest {
            agent: ModelAgent::Claude,
            prompt: "describe".into(),
            images: vec![],
            schema: style_schema(),
            model: None,
            timeout_secs: None,
        };
        let empty = run(
            dir.path(),
            ModelOnceRequest {
                prompt: " ".into(),
                ..base.clone()
            },
        )
        .await;
        assert_eq!(empty["ok"], false);
        let bad = run(
            dir.path(),
            ModelOnceRequest {
                schema: json!({ "type": "array" }),
                ..base.clone()
            },
        )
        .await;
        assert_eq!(bad["ok"], false);
        let missing = run(
            dir.path(),
            ModelOnceRequest {
                images: vec!["nope.png".into()],
                ..base
            },
        )
        .await;
        assert!(missing["note"].as_str().unwrap().contains("nope.png"));
    }
}
