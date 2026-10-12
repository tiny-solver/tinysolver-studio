//! The flow's `agent` node: one agent loop, no human at the keyboard.
//!
//! A node names an agent (claude | codex), a one-line goal, the Studio parts
//! it may use, what it is fed (the previous node's result), when to stop, and
//! the shape of what it must hand back. [`run_agent_node`] opens a fresh ACP
//! session on the project folder (the same spawn → conversation → prompt →
//! `TurnComplete` path the automation engine uses, so it works in
//! `codeg-server` as well as the desktop app), watches the session's events on
//! the internal bus, and settles into one [`AgentNodeOutcome`]: the answer,
//! the transcript, steps, time, cost and why it stopped.
//!
//! What the agent can reach is narrowed twice:
//! - the `codeg-mcp` companion of a node session carries the `studio` group
//!   only, and the user's own MCP servers are left out (no delegation, no
//!   ask, no automations — a node must not spawn helpers or open side
//!   doors), see [`narrow_mcp_servers`];
//! - every `studio_*` call is checked against the node's part list at the
//!   broker ([`token_allows`]), so a part the node was not given answers
//!   `ok: false` even if the agent finds its tool name.
//!
//! Permission questions the agent raises are answered here: a part on the
//! list is allowed, anything else goes to the caller's [`AskHuman`] (the
//! flow's human card) and is refused when there is no one to ask.
//!
//! Kept out of `acp/` (upstream) so a sync only carries the call sites:
//! `connection.rs` (companion scope + cost note) and `listener.rs` (part check).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, RwLock};

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, PermissionOptionInfo, PromptInputBlock};
use crate::acp::InternalEventBus;
use crate::app_state::AppState;
use crate::commands::acp::{build_session_runtime_env, verify_agent_installed};
use crate::commands::conversations::{
    create_conversation_core, emit_conversation_upsert, get_folder_conversation_core,
};
use crate::db::service::{conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::studio_ops;
use crate::studio_tools::StudioOp;
use crate::web::event_bridge::EventEmitter;

/// Owner label prefix of node sessions. The companion injection reads it
/// (through [`companion_scope_for_owner`]) to narrow the tool groups.
pub const OWNER_PREFIX: &str = "studio_agent:";

/// How many times a node may be asked to fix an answer that does not fit
/// `output` before the node fails.
const MAX_FIX_ROUNDS: u32 = 2;
/// After a stop condition cancels the turn, how long to wait for the agent to
/// acknowledge before tearing the session down anyway.
const CANCEL_GRACE: Duration = Duration::from_secs(20);

// ── the node ─────────────────────────────────────────────────────────────────

/// One `agent` node of a flow, as written in `flows/<id>.flow.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentNodeSpec {
    /// `claude` | `codex`.
    pub agent: String,
    /// What the agent should get done, one line.
    pub goal: String,
    /// Studio parts the agent may call (registry names — `read_scene`, or the
    /// MCP tool name `studio_read_scene`). Empty: no Studio parts at all.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub stop: StopRule,
    /// JSON Schema the answer must fit. `None`: the final text is the answer.
    #[serde(default)]
    pub output: Option<Value>,
    /// Agent mode to start in (e.g. claude `default` | `acceptEdits`). `None`:
    /// the agent's own default — every ask then reaches [`AskHuman`].
    #[serde(default)]
    pub mode: Option<String>,
}

/// When the loop stops, besides the agent saying it is done.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StopRule {
    /// Steps the agent may take (tool calls). Past it the turn is cancelled.
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default = "default_max_seconds")]
    pub max_seconds: u64,
    /// Session cost ceiling, when the agent reports cost (claude does).
    #[serde(default)]
    pub max_cost_usd: Option<f64>,
}

fn default_max_turns() -> u32 {
    30
}
fn default_max_seconds() -> u64 {
    600
}

impl Default for StopRule {
    fn default() -> Self {
        Self {
            max_turns: default_max_turns(),
            max_seconds: default_max_seconds(),
            max_cost_usd: None,
        }
    }
}

/// What a node run leaves in the run record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentNodeOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The answer, shaped by `output` when one was given.
    pub output: Value,
    /// The agent's last message as written.
    pub text: Option<String>,
    /// `done` | `max_turns` | `max_seconds` | `max_cost` | `refused` | the
    /// agent's own stop reason when it ended otherwise.
    pub stop_reason: String,
    pub turns: u32,
    pub steps: u32,
    pub duration_ms: u64,
    pub cost_usd: Option<f64>,
    pub conversation_id: Option<i32>,
    /// The conversation as the agent's own session file records it.
    pub transcript: Option<Value>,
    /// Permission questions and how each was answered.
    pub asks: Vec<AskRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AskRecord {
    pub tool: String,
    pub title: String,
    /// `allowed` (a listed part) | `human:<option>` | `refused`.
    pub answer: String,
}

/// A permission question put to a person.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionAsk {
    pub tool: String,
    pub title: String,
    pub tool_call: Value,
    pub options: Vec<PermissionOptionInfo>,
}

/// Puts a [`PermissionAsk`] in front of a person and waits for the chosen
/// `option_id`. `None` refuses.
pub type AskHuman = Arc<dyn Fn(PermissionAsk) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// What a node run needs from the app. Both runtimes hold these in
/// [`AppState`].
pub struct AgentNodeCtx<'a> {
    pub db: &'a AppDatabase,
    pub manager: &'a ConnectionManager,
    pub bus: &'a InternalEventBus,
    pub emitter: &'a EventEmitter,
    pub data_dir: &'a Path,
}

impl<'a> AgentNodeCtx<'a> {
    pub fn from_app_state(state: &'a AppState) -> Self {
        Self {
            db: &state.db,
            manager: &state.connection_manager,
            bus: &state.acp_event_bus,
            emitter: &state.emitter,
            data_dir: &state.data_dir,
        }
    }
}

/// The app pieces a node needs, installed once at boot (both runtimes, next
/// to the automation engine) so a flow — which runs off the project folder
/// and the part registry — can reach the ACP sessions.
pub struct AgentHost {
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: std::path::PathBuf,
}

static HOST: OnceLock<AgentHost> = OnceLock::new();

/// Called at boot. A process that never calls it (the `studio` CLI, tests)
/// answers agent nodes with `ok: false`.
pub fn install(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: std::path::PathBuf,
) {
    let _ = HOST.set(AgentHost {
        db,
        manager,
        emitter,
        bus,
        data_dir,
    });
}

/// [`run_agent_node`] on the installed host.
pub async fn run_installed(
    project: &Path,
    spec: &AgentNodeSpec,
    input: &Value,
    ask: Option<AskHuman>,
) -> AgentNodeOutcome {
    match HOST.get() {
        Some(h) => {
            let ctx = AgentNodeCtx {
                db: &h.db,
                manager: &h.manager,
                bus: &h.bus,
                emitter: &h.emitter,
                data_dir: &h.data_dir,
            };
            run_agent_node(&ctx, project, spec, input, ask).await
        }
        None => AgentNodeOutcome::failed(
            "agent nodes run inside the Studio app or codeg-server — this process has no agent sessions",
        ),
    }
}

/// Problems with a node as written, each a readable line (for flow validate).
pub fn check_spec(spec: &AgentNodeSpec) -> Vec<String> {
    let mut issues = Vec::new();
    if let Err(e) = parse_agent(&spec.agent) {
        issues.push(e);
    }
    if spec.goal.trim().is_empty() {
        issues.push("goal is empty — say what the agent should get done".into());
    }
    for t in &spec.tools {
        let op = op_name(t);
        match studio_ops::registry().find(&op) {
            Some(s) if s.tool.is_some() => {}
            Some(_) => issues.push(format!("tool `{t}` is an editor-only part — agents cannot call it")),
            None => issues.push(format!("tool `{t}` is not a Studio part")),
        }
    }
    if spec.stop.max_turns == 0 || spec.stop.max_seconds == 0 {
        issues.push("stop.max_turns and stop.max_seconds must be above 0".into());
    }
    if let Some(schema) = &spec.output {
        if let Err(e) = jsonschema::validator_for(schema) {
            issues.push(format!("output is not a JSON Schema: {e}"));
        }
    }
    issues
}

impl AgentNodeOutcome {
    fn failed(note: &str) -> Self {
        Self {
            ok: false,
            note: Some(note.to_string()),
            output: Value::Null,
            text: None,
            stop_reason: "error".into(),
            turns: 0,
            steps: 0,
            duration_ms: 0,
            cost_usd: None,
            conversation_id: None,
            transcript: None,
            asks: Vec::new(),
        }
    }
}

// ── scope: which parts a node session may call ───────────────────────────────

#[derive(Default)]
struct Scopes {
    /// owner label → allowed op names.
    by_owner: HashMap<String, Arc<HashSet<String>>>,
    /// companion token → allowed op names.
    by_token: HashMap<String, Arc<HashSet<String>>>,
    /// connection id → last reported session cost (USD).
    cost: HashMap<String, f64>,
}

fn scopes() -> &'static std::sync::Mutex<Scopes> {
    static S: OnceLock<std::sync::Mutex<Scopes>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// A part as the node names it — registry op (`read_scene`) or MCP tool
/// (`studio_read_scene`, `mcp__codeg-mcp__studio_render`) — as its op name.
fn op_name(tool: &str) -> String {
    let t = tool.trim();
    let t = t.strip_prefix("mcp__codeg-mcp__").unwrap_or(t);
    match studio_ops::registry().find_tool(t) {
        Some(spec) => spec.op.clone(),
        None => t.to_string(),
    }
}

/// The MCP tool names of a node's parts (editor-only parts have none).
fn tool_names(ops: &HashSet<String>) -> Vec<String> {
    let mut names: Vec<String> = ops
        .iter()
        .filter_map(|op| studio_ops::registry().find(op).and_then(|s| s.tool.clone()))
        .collect();
    names.sort();
    names
}

/// Env var the companion of a node session reads its part list from.
pub const TOOLS_ENV: &str = "CODEG_STUDIO_TOOLS";

/// Inside the `codeg-mcp` companion: whether a `studio_*` tool may be listed
/// and called. Unset (every session that is not a node's) → all of them.
pub fn companion_lists_tool(name: &str) -> bool {
    static LIST: OnceLock<Option<HashSet<String>>> = OnceLock::new();
    LIST.get_or_init(|| {
        std::env::var(TOOLS_ENV)
            .ok()
            .map(|v| v.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect())
    })
    .as_ref()
    .is_none_or(|list| list.contains(name))
}

/// `Some` when `owner` is a node session: `token` is bound to the node's part
/// list for [`token_allows`]. Fails closed: a node label with no registered
/// scope gets an empty list.
fn companion_scope_for_owner(owner: &str, token: &str) -> Option<()> {
    if !owner.starts_with(OWNER_PREFIX) {
        return None;
    }
    let mut s = scopes().lock().unwrap_or_else(|e| e.into_inner());
    let allow = s.by_owner.get(owner).cloned().unwrap_or_default();
    s.by_token.insert(token.to_string(), allow);
    Some(())
}

/// Called where a session's MCP servers are assembled. For a node session:
/// keep the `codeg-mcp` companion alone (the user's own servers are other
/// doors), cut its tool groups down to `studio`, and bind its token to the
/// node's part list. Any other session passes through untouched.
pub fn narrow_mcp_servers(
    owner: &str,
    servers: &mut Vec<sacp::schema::McpServer>,
    companion_token: Option<&str>,
) {
    use sacp::schema::McpServer;
    if !owner.starts_with(OWNER_PREFIX) {
        return;
    }
    let allow = companion_token.and_then(|token| {
        companion_scope_for_owner(owner, token);
        let s = scopes().lock().unwrap_or_else(|e| e.into_inner());
        s.by_token.get(token).cloned()
    });
    let listed = allow.map(|a| tool_names(&a)).unwrap_or_default();
    servers.retain_mut(|server| {
        let McpServer::Stdio(stdio) = server else {
            return false;
        };
        if stdio.name != "codeg-mcp" {
            return false;
        }
        let Some(i) = stdio.args.iter().position(|a| a == "--features") else {
            return false;
        };
        let has_studio = stdio
            .args
            .get(i + 1)
            .is_some_and(|f| f.split(',').any(|g| g.trim() == "studio"));
        if !has_studio {
            return false;
        }
        stdio.args[i + 1] = "studio".into();
        stdio.env.retain(|e| e.name != TOOLS_ENV);
        stdio
            .env
            .push(sacp::schema::EnvVariable::new(TOOLS_ENV, listed.join(",")));
        // The delegate-target lists only matter to the delegation group.
        for flag in ["--custom-agents", "--disabled-agents"] {
            if let Some(j) = stdio.args.iter().position(|a| a == flag) {
                stdio.args.drain(j..(j + 2).min(stdio.args.len()));
            }
        }
        true
    });
}

/// Called by the broker before running a studio op. `true` for every token
/// that is not a node session's.
pub fn token_allows(token: &str, op: &StudioOp) -> bool {
    let s = scopes().lock().unwrap_or_else(|e| e.into_inner());
    match s.by_token.get(token) {
        None => true,
        Some(allow) => allow.contains(studio_ops::op_name(op)),
    }
}

/// Called where the agent reports usage: remember the session cost.
pub fn note_cost(connection_id: &str, amount: f64, currency: &str) {
    if !currency.eq_ignore_ascii_case("USD") {
        return;
    }
    let mut s = scopes().lock().unwrap_or_else(|e| e.into_inner());
    if s.cost.contains_key(connection_id) {
        s.cost.insert(connection_id.to_string(), amount);
    }
}

fn session_cost(connection_id: &str) -> Option<f64> {
    let s = scopes().lock().unwrap_or_else(|e| e.into_inner());
    s.cost.get(connection_id).copied().filter(|c| *c >= 0.0)
}

/// Registers a node's scope for its lifetime and clears every trace on drop.
struct ScopeGuard {
    owner: String,
    conn_id: Option<String>,
}

impl ScopeGuard {
    fn new(owner: String, tools: &[String]) -> Self {
        let allow: HashSet<String> = tools.iter().map(|t| op_name(t)).collect();
        scopes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .by_owner
            .insert(owner.clone(), Arc::new(allow));
        Self {
            owner,
            conn_id: None,
        }
    }

    fn track_cost(&mut self, conn_id: &str) {
        self.conn_id = Some(conn_id.to_string());
        scopes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cost
            .insert(conn_id.to_string(), -1.0);
    }
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        let mut s = scopes().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(allow) = s.by_owner.remove(&self.owner) {
            s.by_token.retain(|_, a| !Arc::ptr_eq(a, &allow));
        }
        if let Some(c) = &self.conn_id {
            s.cost.remove(c);
        }
    }
}

// ── the run ──────────────────────────────────────────────────────────────────

fn parse_agent(agent: &str) -> Result<AgentType, String> {
    match agent.trim() {
        "claude" | "claude_code" => Ok(AgentType::ClaudeCode),
        "codex" => Ok(AgentType::Codex),
        other => Err(format!("agent `{other}` — claude | codex")),
    }
}

/// The prompt the node opens with.
fn opening_prompt(spec: &AgentNodeSpec, input: &Value) -> String {
    let mut p = format!("목표: {}\n", spec.goal.trim());
    if !input.is_null() {
        p.push_str(&format!(
            "\n넣는 것(앞 단계 결과):\n```json\n{}\n```\n",
            serde_json::to_string_pretty(input).unwrap_or_default()
        ));
    }
    if spec.tools.is_empty() {
        p.push_str("\nStudio 부품은 쓰지 않는다.\n");
    } else {
        let ops: HashSet<String> = spec.tools.iter().map(|t| op_name(t)).collect();
        let names = tool_names(&ops);
        p.push_str(&format!(
            "\n쓸 수 있는 Studio 부품(codeg-mcp 도구): {}. 다른 부품은 거절된다.\n",
            names.join(", ")
        ));
    }
    p.push_str(&format!(
        "\n도구 호출은 {}번까지 · {}초 안에 끝낸다. 사람에게 묻지 않고 혼자 끝낸다.\n",
        spec.stop.max_turns, spec.stop.max_seconds
    ));
    match &spec.output {
        Some(schema) => p.push_str(&format!(
            "\n끝나면 마지막 메시지에 결과를 이 JSON Schema 에 맞는 JSON 하나로 ```json 블록에 담는다:\n```json\n{}\n```\n",
            serde_json::to_string_pretty(schema).unwrap_or_default()
        )),
        None => p.push_str("\n끝나면 한 일을 짧게 적고 멈춘다.\n"),
    }
    p
}

/// Pull the answer out of the agent's last message: the last ```json block,
/// else the last top-level `{…}`.
fn extract_json(text: &str) -> Option<Value> {
    let mut found = None;
    let mut rest = text;
    while let Some(i) = rest.find("```json") {
        let after = &rest[i + 7..];
        let Some(end) = after.find("```") else { break };
        if let Ok(v) = serde_json::from_str::<Value>(after[..end].trim()) {
            found = Some(v);
        }
        rest = &after[end + 3..];
    }
    if found.is_some() {
        return found;
    }
    let start = text.rfind('{')?;
    // Walk back to an opening brace whose object parses to the end.
    for (i, _) in text[..=start].match_indices('{') {
        if let Ok(v) = serde_json::from_str::<Value>(text[i..].trim()) {
            return Some(v);
        }
        if let Some(end) = text.rfind('}') {
            if end > i {
                if let Ok(v) = serde_json::from_str::<Value>(&text[i..=end]) {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// `value` against the node's `output` schema — the validator `model_once` uses.
fn check_shape(schema: &Value, value: &Value) -> Result<(), String> {
    let validator = jsonschema::validator_for(schema)
        .map_err(|e| format!("output 이 JSON Schema 가 아니다: {e}"))?;
    let errors: Vec<String> = validator
        .iter_errors(value)
        .take(5)
        .map(|e| {
            let at = e.instance_path().to_string();
            if at.is_empty() {
                e.to_string()
            } else {
                format!("{at}: {e}")
            }
        })
        .collect();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// The answer from the last message, or why it does not fit.
fn settle_answer(spec: &AgentNodeSpec, text: Option<&str>) -> Result<Value, String> {
    let text = text.map(str::trim).filter(|t| !t.is_empty());
    let Some(schema) = &spec.output else {
        return Ok(text.map(|t| Value::String(t.to_string())).unwrap_or(Value::Null));
    };
    let text = text.ok_or("마지막 메시지가 비었다")?;
    let v = extract_json(text).ok_or("마지막 메시지에 JSON 이 없다")?;
    check_shape(schema, &v)?;
    Ok(v)
}

/// The tool name a permission question is about: claude's
/// `_meta.claudeCode.toolName`, else the title.
fn asked_tool(tool_call: &Value) -> (String, String) {
    let title = tool_call
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = tool_call
        .pointer("/_meta/claudeCode/toolName")
        .or_else(|| tool_call.pointer("/meta/claudeCode/toolName"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| title.clone());
    (name, title)
}

/// The part a tool name stands for, when it is a codeg-mcp studio tool.
fn studio_part(tool: &str) -> Option<String> {
    let t = tool.trim();
    let bare = t
        .strip_prefix("mcp__codeg-mcp__")
        .or_else(|| t.strip_prefix("codeg-mcp."))
        .or_else(|| t.strip_prefix("codeg-mcp/"))
        .unwrap_or(t);
    studio_ops::is_mcp_tool(bare).then(|| op_name(bare))
}

fn pick_option(options: &[PermissionOptionInfo], kinds: &[&str]) -> Option<String> {
    kinds.iter().find_map(|k| {
        options
            .iter()
            .find(|o| o.kind == *k)
            .map(|o| o.option_id.clone())
    })
}

enum Stopping {
    No,
    Because(&'static str, Instant),
}

/// Run one `agent` node to the end. Never panics on the agent's account: every
/// failure comes back as `ok: false` with a note, like the other parts.
pub async fn run_agent_node(
    ctx: &AgentNodeCtx<'_>,
    project: &Path,
    spec: &AgentNodeSpec,
    input: &Value,
    ask: Option<AskHuman>,
) -> AgentNodeOutcome {
    let started = Instant::now();
    let mut out = AgentNodeOutcome::failed("");
    out.note = None;
    out.stop_reason = String::new();
    if let Err(note) = run_inner(ctx, project, spec, input, ask, &mut out).await {
        out.ok = false;
        out.note = Some(note);
        if out.stop_reason.is_empty() {
            out.stop_reason = "error".into();
        }
    }
    out.duration_ms = started.elapsed().as_millis() as u64;
    if let Some(conv) = out.conversation_id {
        if let Ok((detail, _)) = get_folder_conversation_core(&ctx.db.conn, conv).await {
            out.transcript = serde_json::to_value(detail).ok();
        }
    }
    out
}

async fn run_inner(
    ctx: &AgentNodeCtx<'_>,
    project: &Path,
    spec: &AgentNodeSpec,
    input: &Value,
    ask: Option<AskHuman>,
    out: &mut AgentNodeOutcome,
) -> Result<(), String> {
    let agent_type = parse_agent(&spec.agent)?;
    if spec.goal.trim().is_empty() {
        return Err("goal 이 비었다".into());
    }
    let project_str = project
        .to_str()
        .ok_or("project path is not UTF-8")?
        .to_string();
    if !project.is_dir() {
        return Err(format!("project folder not found: {project_str}"));
    }

    let owner = format!("{OWNER_PREFIX}{}", uuid::Uuid::new_v4());
    let mut scope = ScopeGuard::new(owner.clone(), &spec.tools);
    let allow: HashSet<String> = spec.tools.iter().map(|t| op_name(t)).collect();

    let runtime_env = build_session_runtime_env(ctx.db, agent_type, None, ctx.data_dir)
        .await
        .map_err(|e| e.to_string())?;
    verify_agent_installed(agent_type)
        .await
        .map_err(|e| e.to_string())?;
    let folder = folder_service::ensure_folder_for_path(&ctx.db.conn, &project_str)
        .await
        .map_err(|e| e.to_string())?;

    // Subscribe before the spawn so nothing the session says is missed.
    let mut rx = ctx.bus.subscribe();
    let conn_id = ctx
        .manager
        .spawn_agent(
            agent_type,
            Some(project_str.clone()),
            None,
            runtime_env,
            owner.clone(),
            ctx.emitter.clone(),
            spec.mode.clone(),
            Default::default(),
        )
        .await
        .map_err(|e| e.to_string())?;
    scope.track_cost(&conn_id);

    let result = drive(ctx, spec, input, ask, &allow, &conn_id, folder.id, agent_type, &mut rx, out).await;
    let _ = ctx.manager.disconnect(&conn_id).await;
    drop(scope);
    result
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    ctx: &AgentNodeCtx<'_>,
    spec: &AgentNodeSpec,
    input: &Value,
    ask: Option<AskHuman>,
    allow: &HashSet<String>,
    conn_id: &str,
    folder_id: i32,
    agent_type: AgentType,
    rx: &mut tokio::sync::broadcast::Receiver<Arc<crate::acp::types::EventEnvelope>>,
    out: &mut AgentNodeOutcome,
) -> Result<(), String> {
    let title: String = format!("흐름 · {}", spec.goal.trim()).chars().take(80).collect();
    let conversation_id = create_conversation_core(&ctx.db.conn, folder_id, agent_type, Some(title))
        .await
        .map_err(|e| e.to_string())?;
    let _ = conversation_service::lock_title(&ctx.db.conn, conversation_id).await;
    emit_conversation_upsert(ctx.emitter, &ctx.db.conn, conversation_id).await;
    out.conversation_id = Some(conversation_id);

    let send = |text: String| async move {
        ctx.manager
            .send_prompt_linked_with_message_id(
                ctx.db,
                conn_id,
                vec![PromptInputBlock::Text { text }],
                Some(folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    send(opening_prompt(spec, input)).await?;
    out.turns = 1;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(spec.stop.max_seconds.max(1));
    let mut stopping = Stopping::No;
    let mut fix_rounds = 0u32;
    let mut seen_calls: HashSet<String> = HashSet::new();
    let asks_log = Arc::new(RwLock::new(Vec::<AskRecord>::new()));
    // Answers from the human card come back here so the loop never blocks on one.
    let (answer_tx, mut answer_rx) = mpsc::unbounded_channel::<(String, String)>();

    let cancel = |why: &'static str| async move {
        let _ = ctx.manager.cancel(&ctx.db.conn, conn_id).await;
        Stopping::Because(why, Instant::now())
    };

    loop {
        let grace_left = match stopping {
            Stopping::Because(_, at) => CANCEL_GRACE.saturating_sub(at.elapsed()),
            Stopping::No => Duration::from_secs(3600),
        };
        tokio::select! {
            ev = rx.recv() => {
                let env = match ev {
                    Ok(env) => env,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return Err("event bus closed".into()),
                };
                if env.connection_id != conn_id {
                    continue;
                }
                match &env.payload {
                    AcpEvent::ToolCall { tool_call_id, .. } => {
                        if seen_calls.insert(tool_call_id.clone()) {
                            out.steps += 1;
                            if out.steps > spec.stop.max_turns && matches!(stopping, Stopping::No) {
                                stopping = cancel("max_turns").await;
                            }
                        }
                    }
                    AcpEvent::UsageUpdate { .. } => {
                        out.cost_usd = session_cost(conn_id);
                        let over = matches!((spec.stop.max_cost_usd, out.cost_usd), (Some(cap), Some(c)) if c > cap);
                        if over && matches!(stopping, Stopping::No) {
                            stopping = cancel("max_cost").await;
                        }
                    }
                    AcpEvent::PermissionRequest { request_id, tool_call, options, .. } => {
                        let (tool, title) = asked_tool(tool_call);
                        if studio_part(&tool).is_some_and(|p| allow.contains(&p)) {
                            if let Some(opt) = pick_option(options, &["allow_once", "allow_always"]) {
                                let _ = ctx.manager.respond_permission(conn_id, request_id, &opt).await;
                                asks_log.write().await.push(AskRecord { tool, title, answer: "allowed".into() });
                                continue;
                            }
                        }
                        let reject = pick_option(options, &["reject_once", "reject_always"]);
                        match (&ask, &stopping) {
                            (Some(ask), Stopping::No) => {
                                let ask = ask.clone();
                                let tx = answer_tx.clone();
                                let log = asks_log.clone();
                                let request_id = request_id.clone();
                                let q = PermissionAsk {
                                    tool: tool.clone(),
                                    title: title.clone(),
                                    tool_call: tool_call.clone(),
                                    options: options.clone(),
                                };
                                tokio::spawn(async move {
                                    let picked = ask(q).await;
                                    let (answer, opt) = match picked {
                                        Some(o) => (format!("human:{o}"), Some(o)),
                                        None => ("refused".to_string(), reject),
                                    };
                                    log.write().await.push(AskRecord { tool, title, answer });
                                    if let Some(o) = opt {
                                        let _ = tx.send((request_id, o));
                                    }
                                });
                            }
                            _ => {
                                if let Some(o) = reject {
                                    let _ = ctx.manager.respond_permission(conn_id, request_id, &o).await;
                                }
                                asks_log.write().await.push(AskRecord { tool, title, answer: "refused".into() });
                            }
                        }
                    }
                    AcpEvent::TurnComplete { stop_reason, .. } => {
                        out.cost_usd = session_cost(conn_id).or(out.cost_usd);
                        let text = match ctx.manager.get_state_and_emitter(conn_id).await {
                            Some((state, _)) => state.read().await.last_assistant_text.clone(),
                            None => None,
                        };
                        out.text = text.clone().filter(|t| !t.trim().is_empty());
                        if let Stopping::Because(why, _) = stopping {
                            out.stop_reason = why.into();
                            out.note = Some(format!("멈춤: {why}"));
                            break;
                        }
                        if stop_reason != "end_turn" {
                            out.stop_reason = stop_reason.clone();
                            out.note = Some(format!("agent stopped: {stop_reason}"));
                            break;
                        }
                        match settle_answer(spec, out.text.as_deref()) {
                            Ok(v) => {
                                out.ok = true;
                                out.output = v;
                                out.stop_reason = "done".into();
                                break;
                            }
                            Err(why) if fix_rounds < MAX_FIX_ROUNDS => {
                                fix_rounds += 1;
                                out.turns += 1;
                                send(format!(
                                    "결과가 나오는 것 모양에 맞지 않는다({why}). 같은 일을 다시 하지 말고, 스키마에 맞는 JSON 하나를 ```json 블록으로 다시 적는다."
                                ))
                                .await?;
                            }
                            Err(why) => {
                                out.stop_reason = "bad_output".into();
                                out.note = Some(why);
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some((request_id, option)) = answer_rx.recv() => {
                let _ = ctx.manager.respond_permission(conn_id, &request_id, &option).await;
            }
            _ = tokio::time::sleep_until(deadline), if matches!(stopping, Stopping::No) => {
                stopping = cancel("max_seconds").await;
            }
            _ = tokio::time::sleep(grace_left), if !matches!(stopping, Stopping::No) => {
                if let Stopping::Because(why, _) = stopping {
                    out.stop_reason = why.into();
                    out.note = Some(format!("멈춤: {why} (에이전트가 취소에 답하지 않음)"));
                }
                break;
            }
        }
    }
    out.asks = asks_log.read().await.clone();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn op_names_from_tool_names() {
        assert_eq!(op_name("studio_read_scene"), "read_scene");
        assert_eq!(op_name("read_scene"), "read_scene");
        assert_eq!(op_name("mcp__codeg-mcp__studio_apply_scene_commands"), "apply_commands");
        assert_eq!(op_name("studio_render"), "render_asset");
        assert_eq!(op_name("render_asset"), "render_asset");
        let ops: HashSet<String> = ["apply_commands", "render_asset", "list_scenes"].map(String::from).into();
        assert_eq!(tool_names(&ops), vec!["studio_apply_scene_commands", "studio_list_scenes", "studio_render"]);
        assert_eq!(studio_part("mcp__codeg-mcp__studio_list_scenes").as_deref(), Some("list_scenes"));
        assert_eq!(studio_part("Bash"), None);
    }

    #[test]
    fn scope_narrows_only_node_tokens() {
        let owner = format!("{OWNER_PREFIX}t1");
        let g = ScopeGuard::new(owner.clone(), &["studio_read_scene".into(), "list_scenes".into()]);
        assert!(companion_scope_for_owner("automation", "tok-x").is_none());
        assert!(companion_scope_for_owner(&owner, "tok-1").is_some());
        let read = StudioOp::ReadScene { scene: "a".into() };
        assert!(token_allows("tok-1", &read));
        assert!(token_allows("tok-1", &StudioOp::ListScenes));
        assert!(!token_allows("tok-1", &StudioOp::Build));
        assert!(token_allows("tok-x", &StudioOp::Build));
        drop(g);
        // Gone with the node.
        assert!(token_allows("tok-1", &StudioOp::Build));
    }

    #[test]
    fn node_sessions_keep_the_studio_companion_only() {
        use sacp::schema::{McpServer, McpServerStdio};
        let owner = format!("{OWNER_PREFIX}n");
        let _g = ScopeGuard::new(owner.clone(), &["list_scenes".into()]);
        let companion = |features: &str| {
            McpServer::Stdio(McpServerStdio::new("codeg-mcp", "/bin/codeg-mcp").args(vec![
                "--token".into(),
                "tok-n".into(),
                "--features".into(),
                features.into(),
                "--custom-agents".into(),
                "x".into(),
            ]))
        };
        let user = McpServer::Stdio(McpServerStdio::new("github", "/bin/gh-mcp"));
        let mut servers = vec![user.clone(), companion("delegation,ask,studio")];
        narrow_mcp_servers(&owner, &mut servers, Some("tok-n"));
        assert_eq!(servers.len(), 1);
        let McpServer::Stdio(s) = &servers[0] else { panic!() };
        assert_eq!(s.args, vec!["--token", "tok-n", "--features", "studio"]);
        assert_eq!(s.env.len(), 1);
        assert_eq!((s.env[0].name.as_str(), s.env[0].value.as_str()), (TOOLS_ENV, "studio_list_scenes"));
        assert!(token_allows("tok-n", &StudioOp::ListScenes));
        assert!(!token_allows("tok-n", &StudioOp::Build));

        // Not a content project → no studio group → nothing at all.
        let mut servers = vec![companion("delegation,ask")];
        narrow_mcp_servers(&owner, &mut servers, None);
        assert!(servers.is_empty());

        // Other sessions untouched.
        let mut servers = vec![user, companion("delegation")];
        narrow_mcp_servers("automation", &mut servers, Some("tok-a"));
        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn unregistered_node_owner_fails_closed() {
        let owner = format!("{OWNER_PREFIX}ghost");
        assert!(companion_scope_for_owner(&owner, "tok-ghost").is_some());
        assert!(!token_allows("tok-ghost", &StudioOp::ListScenes));
        scopes().lock().unwrap().by_token.remove("tok-ghost");
    }

    #[test]
    fn answer_from_last_message() {
        let spec = AgentNodeSpec {
            agent: "claude".into(),
            goal: "g".into(),
            tools: vec![],
            stop: StopRule::default(),
            output: Some(json!({
                "type": "object",
                "required": ["scene", "changed"],
                "properties": { "scene": {"type": "string"}, "changed": {"type": "integer"} }
            })),
            mode: None,
        };
        let text = "고쳤다.\n```json\n{\"scene\": \"intro\", \"changed\": 3}\n```\n";
        assert_eq!(settle_answer(&spec, Some(text)).unwrap(), json!({"scene":"intro","changed":3}));
        let bare = "끝: {\"scene\": \"intro\", \"changed\": 2}";
        assert_eq!(settle_answer(&spec, Some(bare)).unwrap()["changed"], 2);
        assert!(settle_answer(&spec, Some("{\"scene\": \"intro\"}")).unwrap_err().contains("changed"));
        assert!(settle_answer(&spec, Some("{\"scene\": 1, \"changed\": 1}")).is_err());
        assert!(settle_answer(&spec, Some("JSON 없음")).is_err());
        let free = AgentNodeSpec { output: None, ..spec };
        assert_eq!(settle_answer(&free, Some(" done ")).unwrap(), json!("done"));
    }

    #[test]
    fn spec_check_names_the_problems() {
        let ok: AgentNodeSpec = serde_json::from_value(json!({
            "agent": "claude", "goal": "g", "tools": ["read_scene", "studio_apply_scene_commands"],
            "output": { "type": "object" }
        }))
        .unwrap();
        assert!(check_spec(&ok).is_empty(), "{:?}", check_spec(&ok));
        let bad: AgentNodeSpec = serde_json::from_value(json!({
            "agent": "gemini", "goal": " ", "tools": ["fly"], "stop": { "max_turns": 0 },
            "output": { "type": 3 }
        }))
        .unwrap();
        assert_eq!(check_spec(&bad).len(), 5, "{:?}", check_spec(&bad));
    }

    #[tokio::test]
    async fn without_a_host_the_node_says_so() {
        let spec: AgentNodeSpec = serde_json::from_value(json!({ "agent": "claude", "goal": "g" })).unwrap();
        let out = run_installed(Path::new("/tmp"), &spec, &Value::Null, None).await;
        assert!(!out.ok);
        assert!(out.note.unwrap().contains("codeg-server"));
    }

    #[test]
    fn opening_prompt_names_the_real_tools() {
        let spec: AgentNodeSpec = serde_json::from_value(json!({
            "agent": "claude", "goal": "g", "tools": ["apply_commands", "render_asset"]
        }))
        .unwrap();
        let p = opening_prompt(&spec, &Value::Null);
        assert!(p.contains("studio_apply_scene_commands, studio_render"), "{p}");
        assert!(!p.contains("studio_apply_commands"));
    }

    #[test]
    fn spec_reads_with_defaults() {
        let spec: AgentNodeSpec = serde_json::from_value(json!({
            "agent": "codex", "goal": "장면 intro 의 배경을 밤으로", "tools": ["read_scene", "apply_commands"]
        }))
        .unwrap();
        assert_eq!(spec.stop, StopRule::default());
        assert!(spec.output.is_none());
        assert!(parse_agent(&spec.agent).is_ok());
        assert!(parse_agent("gemini").is_err());
    }

    #[test]
    fn cost_only_for_tracked_usd_sessions() {
        let mut g = ScopeGuard::new(format!("{OWNER_PREFIX}c"), &[]);
        note_cost("conn-untracked", 1.0, "USD");
        assert_eq!(session_cost("conn-untracked"), None);
        g.track_cost("conn-c");
        assert_eq!(session_cost("conn-c"), None);
        note_cost("conn-c", 0.42, "USD");
        assert_eq!(session_cost("conn-c"), Some(0.42));
        drop(g);
        assert_eq!(session_cost("conn-c"), None);
    }
}
