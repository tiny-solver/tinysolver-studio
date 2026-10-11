//! The Studio's doors on the server — the HTTP API and the HTTP MCP endpoint
//! that put the op registry ([`crate::studio_ops`]) in front of callers that
//! are not a Studio session: Claude Desktop (through `/mcp`), `curl`, and the
//! `studio` CLI (through `/api/studio/<op>`).
//!
//! Both doors are built from the registry, like the `codeg-mcp` companion's
//! `studio_*` tools, so a new op shows up everywhere at once. Both sit behind
//! the server token.
//!
//! The one thing a door adds is *which project*. A Studio session has a
//! working directory; a server caller does not, so `project` is resolved here
//! ([`resolve_project`]): an absolute path, or a name under
//! `STUDIO_PROJECTS_DIR`, else `STUDIO_PROJECT`, else the only content project
//! under `STUDIO_PROJECTS_DIR`. `list_projects` is the door's own op that
//! answers "which projects are there".
//!
//! Outcomes stay `{ ok, note?, ... }` with HTTP 200 — a domain failure is a
//! value the caller reads, not a transport error (same rule as the ops).

use std::path::{Path, PathBuf};

use axum::{
    extract::{DefaultBodyLimit, Path as UrlPath, Request},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::acp::delegation::companion::render_studio_result;
use crate::studio_ops::{self, input_with_project, registry};
use crate::studio_tools::is_content_project;

/// Absolute folder holding the content projects a server caller may name.
pub const PROJECTS_DIR_ENV: &str = "STUDIO_PROJECTS_DIR";
/// The project used when a call names none (absolute, or a name).
pub const DEFAULT_PROJECT_ENV: &str = "STUDIO_PROJECT";

/// The door's own op (not a [`studio_tools::StudioOp`]): the projects under
/// `STUDIO_PROJECTS_DIR` and which one is the default.
const LIST_PROJECTS: &str = "list_projects";
const LIST_PROJECTS_TOOL: &str = "studio_list_projects";

/// Same ceiling as `/api/studio_run`: a material upload rides as a data: URL.
const BODY_LIMIT: usize = 300 * 1024 * 1024;

const MCP_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

// ─── Project resolution ───

struct Places {
    projects_dir: Option<PathBuf>,
    default_project: Option<String>,
}

impl Places {
    fn from_env() -> Self {
        let var = |k| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Self {
            projects_dir: var(PROJECTS_DIR_ENV).map(PathBuf::from),
            default_project: var(DEFAULT_PROJECT_ENV),
        }
    }

    /// Content projects directly under the projects folder, sorted by name.
    fn projects(&self) -> Vec<PathBuf> {
        let Some(dir) = &self.projects_dir else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut out: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir() && is_content_project(p))
            .collect();
        out.sort();
        out
    }

    fn named(&self, name: &str) -> Result<PathBuf, String> {
        let path = Path::new(name);
        if path.is_absolute() {
            return Ok(path.to_path_buf());
        }
        let ok_name =
            !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\']);
        if !ok_name {
            return Err(format!(
                "project `{name}`: an absolute path or a folder name"
            ));
        }
        match &self.projects_dir {
            Some(dir) => Ok(dir.join(name)),
            None => Err(format!(
                "project `{name}` is a name but {PROJECTS_DIR_ENV} is not set on the server — pass an absolute path"
            )),
        }
    }

    fn resolve(&self, project: Option<&str>) -> Result<PathBuf, String> {
        if let Some(p) = project {
            return self.named(p);
        }
        if let Some(p) = &self.default_project {
            return self.named(p);
        }
        match self.projects().as_slice() {
            [only] => Ok(only.clone()),
            [] => Err(format!(
                "No project given and none found under {PROJECTS_DIR_ENV}. Pass `project` (an absolute path)."
            )),
            many => Err(format!(
                "No project given — pass `project`, one of: {}",
                many.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy()).collect::<Vec<_>>().join(", ")
            )),
        }
    }

    fn list(&self) -> Value {
        let default = self.resolve(None).ok();
        let projects: Vec<Value> = self
            .projects()
            .iter()
            .map(|p| {
                json!({
                    "name": p.file_name().map(|n| n.to_string_lossy().to_string()),
                    "path": p.to_string_lossy(),
                    "default": default.as_deref() == Some(p.as_path()),
                })
            })
            .collect();
        json!({
            "ok": true,
            "projects_dir": self.projects_dir.as_ref().map(|d| d.to_string_lossy().to_string()),
            "default": default.map(|d| d.to_string_lossy().to_string()),
            "projects": projects,
        })
    }
}

/// The folder a call runs against — see the module docs for the order.
pub fn resolve_project(arguments: &Value) -> Result<PathBuf, String> {
    let project = arguments
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Places::from_env().resolve(project)
}

/// Run one op by its registry id — the body of every door.
pub async fn call(op: &str, arguments: &Value) -> Value {
    if op == LIST_PROJECTS {
        return Places::from_env().list();
    }
    if registry().find(op).is_none() {
        return fail(format!(
            "unknown op `{op}` (GET /api/studio/ops lists them)"
        ));
    }
    match resolve_project(arguments) {
        Ok(root) => studio_ops::call(root, op, arguments).await,
        Err(note) => fail(note),
    }
}

fn list_projects_tool() -> Value {
    json!({
        "name": LIST_PROJECTS_TOOL,
        "description": "List the Studio content projects on this server and which one is the default (used when a studio_* tool is called without `project`). Call this first when the user has not said which project.",
        "inputSchema": { "type": "object", "properties": {} },
    })
}

/// The registry as the HTTP API offers it: the door's `project` added to
/// every op's input, plus `list_projects`.
fn ops_listing() -> Value {
    let reg = registry();
    let mut ops: Vec<Value> = reg
        .ops
        .iter()
        .map(|spec| {
            let mut v = serde_json::to_value(spec).unwrap_or_default();
            v["input"] = input_with_project(spec);
            v
        })
        .collect();
    ops.push(json!({
        "op": LIST_PROJECTS,
        "tool": LIST_PROJECTS_TOOL,
        "group": "door",
        "title": "프로젝트 목록",
        "description": list_projects_tool()["description"],
        "input": { "type": "object", "properties": {} },
        "output": { "type": "object", "properties": { "ok": { "const": true } } },
        "changes": [],
        "uses": [],
    }));
    json!({ "schema": reg.schema, "groups": reg.groups, "failure": reg.failure, "ops": ops })
}

// ─── HTTP API: GET /api/studio/ops · POST /api/studio/{op} ───

/// Routes for the protected `/api` router (the token layer is the router's).
pub fn api_routes() -> Router {
    Router::new().route("/studio/ops", get(api_ops)).route(
        "/studio/{op}",
        post(api_call).layer(DefaultBodyLimit::max(BODY_LIMIT)),
    )
}

async fn api_ops() -> Json<Value> {
    Json(ops_listing())
}

async fn api_call(UrlPath(op): UrlPath<String>, body: Option<Json<Value>>) -> Json<Value> {
    let arguments = body.map(|Json(v)| v).unwrap_or(Value::Null);
    Json(call(&op, &arguments).await)
}

// ─── HTTP MCP: POST /mcp (Streamable HTTP, JSON responses, stateless) ───

/// `/mcp` at the top level, behind the same token as `/api`.
pub fn mcp_routes(token: String) -> Router {
    Router::new()
        .route(
            "/mcp",
            post(mcp_post)
                .get(|| async { StatusCode::METHOD_NOT_ALLOWED })
                .delete(|| async { StatusCode::METHOD_NOT_ALLOWED })
                .layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            crate::web::auth::require_token(req, next, token.clone())
        }))
}

async fn mcp_post(Json(body): Json<Value>) -> Response {
    match body {
        Value::Array(messages) => {
            let mut out = Vec::new();
            for m in messages {
                if let Some(r) = mcp_message(m).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        message => match mcp_message(message).await {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

/// One JSON-RPC message → its response, or `None` for a notification or a
/// client response (both answered by 202 Accepted).
pub async fn mcp_message(message: Value) -> Option<Value> {
    let id = message.get("id").cloned().filter(|v| !v.is_null());
    let method = message.get("method").and_then(Value::as_str)?;
    let id = id?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked
                .filter(|v| MCP_VERSIONS.contains(v))
                .unwrap_or(MCP_VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "serverInfo": { "name": "tinysolver-studio", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} },
                "instructions": "Tinysolver Studio parts (ops) over a content project: scenes, film sets, materials (assets), generation, renders, builds. Every studio_* tool takes an optional `project`; without it the server's default project is used — studio_list_projects shows them.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => {
            let mut tools = vec![list_projects_tool()];
            tools.extend(studio_ops::mcp_tools());
            Ok(json!({ "tools": tools }))
        }
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
            if name == LIST_PROJECTS_TOOL {
                Ok(tool_result(&call(LIST_PROJECTS, &arguments).await))
            } else {
                match registry().find_tool(name) {
                    Some(spec) => Ok(tool_result(&call(&spec.op, &arguments).await)),
                    None => Err((-32602, format!("unknown tool `{name}`"))),
                }
            }
        }
        _ => Err((-32601, format!("method `{method}` not found"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
}

fn tool_result(outcome: &Value) -> Value {
    if outcome.get("projects").is_some() {
        // `list_projects` has no companion renderer; the JSON is the text.
        return json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(outcome).unwrap_or_default() }],
            "isError": false,
            "structuredContent": outcome,
        });
    }
    render_studio_result(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn places(dir: &Path, default: Option<&str>) -> Places {
        Places {
            projects_dir: Some(dir.to_path_buf()),
            default_project: default.map(str::to_string),
        }
    }

    fn content_project(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("codeg-project.json"), r#"{"name":"x"}"#).unwrap();
        p
    }

    #[test]
    fn resolves_absolute_name_default_and_the_only_project() {
        let tmp = tempfile::tempdir().unwrap();
        let none = places(tmp.path(), None);
        assert!(none.resolve(None).unwrap_err().contains("none found"));

        let a = content_project(tmp.path(), "a");
        std::fs::create_dir_all(tmp.path().join("not-a-project")).unwrap();
        assert_eq!(none.resolve(None).unwrap(), a);

        let b = content_project(tmp.path(), "b");
        assert!(none.resolve(None).unwrap_err().contains("a, b"));
        assert_eq!(none.resolve(Some("b")).unwrap(), b);
        assert_eq!(
            none.resolve(Some("/elsewhere")).unwrap(),
            PathBuf::from("/elsewhere")
        );
        assert!(none.resolve(Some("../up")).is_err());
        assert!(none.resolve(Some("a/b")).is_err());

        assert_eq!(places(tmp.path(), Some("a")).resolve(None).unwrap(), a);
        let listed = places(tmp.path(), Some("a")).list();
        assert_eq!(listed["projects"].as_array().unwrap().len(), 2);
        assert_eq!(listed["projects"][0]["default"], true);
        assert_eq!(listed["projects"][1]["default"], false);
    }

    #[test]
    fn a_name_needs_the_projects_dir() {
        let p = Places {
            projects_dir: None,
            default_project: None,
        };
        assert!(p.resolve(Some("a")).unwrap_err().contains(PROJECTS_DIR_ENV));
    }

    #[tokio::test]
    async fn mcp_lists_every_registry_tool_and_list_projects() {
        let init = mcp_message(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }))
            .await
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(
            mcp_message(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
                .await
                .is_none()
        );

        let listed = mcp_message(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await
            .unwrap();
        let tools = listed["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), studio_ops::mcp_tools().len() + 1);
        assert!(tools.iter().any(|t| t["name"] == "studio_list_assets"));
        assert!(tools.iter().any(|t| t["name"] == LIST_PROJECTS_TOOL));
    }

    #[tokio::test]
    async fn mcp_call_runs_the_op_and_refuses_unknown_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().to_string_lossy().to_string();
        let r = mcp_message(json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "studio_list_assets", "arguments": { "project": project } },
        }))
        .await
        .unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert!(r["result"]["structuredContent"]["ok"].is_boolean());

        let bad = mcp_message(json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "nope" },
        }))
        .await
        .unwrap();
        assert_eq!(bad["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn call_refuses_unknown_ops_as_a_value() {
        let out = call("nope", &Value::Null).await;
        assert_eq!(out["ok"], false);
        assert!(out["note"].as_str().unwrap().contains("unknown op"));
    }

    #[test]
    fn ops_listing_adds_project_and_the_door_op() {
        let listing = ops_listing();
        let ops = listing["ops"].as_array().unwrap();
        assert_eq!(ops.len(), registry().ops.len() + 1);
        assert!(ops[0]["input"]["properties"]["project"].is_object());
        assert!(ops.iter().any(|o| o["op"] == LIST_PROJECTS));
    }
}
