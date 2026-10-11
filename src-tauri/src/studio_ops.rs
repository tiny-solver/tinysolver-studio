//! The Studio's parts (ops) as one list — the registry every door reads.
//!
//! `studio_ops.json` names each [`StudioOp`] once: its op id (the serde tag),
//! the MCP tool it is offered as (or none, for the editor's own ops), a
//! group, a short title, the description an LLM reads, what goes in and what
//! comes out (JSON Schema), what it changes and what it reaches outside the
//! project. The doors are built from it rather than kept in step by hand:
//! the `codeg-mcp` companion's `studio_*` tools ([`mcp_tools`]), the `studio`
//! CLI (`studio op list`), and — next — the server's HTTP API and HTTP MCP.
//!
//! The `project` argument is the door's, not the op's: every door that runs
//! against a folder adds [`Registry::project`] to the input it offers.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::studio_tools::StudioOp;

pub const REGISTRY_JSON: &str = include_str!("studio_ops.json");

/// One part.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpSpec {
    /// The [`StudioOp`] serde tag, e.g. `list_assets`.
    pub op: String,
    /// The MCP tool name, e.g. `studio_list_assets`. `None` — the editor's
    /// own op, not offered to agents.
    pub tool: Option<String>,
    /// A key of [`Registry::groups`].
    pub group: String,
    /// A short label for people (Korean, like the rest of the Studio's lists).
    pub title: String,
    /// What the op does, written for the LLM that calls it.
    pub description: String,
    /// JSON Schema of the arguments, without the door's `project`.
    pub input: Value,
    /// JSON Schema of a successful outcome; a failure is [`Registry::failure`].
    pub output: Value,
    /// What it writes: `files` (project documents) · `assets` (the material
    /// register and its files) · `build` · `release`. Empty — read-only.
    pub changes: Vec<String>,
    /// What it reaches outside the project: `genai` · `blender` · `model`
    /// (the claude · codex CLIs) · `network` · `shell`.
    pub uses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    pub schema: u32,
    /// Group id → label.
    pub groups: Map<String, Value>,
    /// The `project` argument the doors add to every op's input.
    pub project: Value,
    /// JSON Schema of every op's failure: `{ ok: false, note }`.
    pub failure: Value,
    pub ops: Vec<OpSpec>,
}

impl Registry {
    pub fn find(&self, op: &str) -> Option<&OpSpec> {
        self.ops.iter().find(|s| s.op == op)
    }

    pub fn find_tool(&self, tool: &str) -> Option<&OpSpec> {
        self.ops.iter().find(|s| s.tool.as_deref() == Some(tool))
    }
}

/// The registry, parsed once. The file is embedded and checked by the tests,
/// so a parse failure is a build defect, not a runtime condition.
pub fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| serde_json::from_str(REGISTRY_JSON).expect("studio_ops.json is valid"))
}

/// Whether `name` is one of the `studio_*` MCP tools.
pub fn is_mcp_tool(name: &str) -> bool {
    registry().find_tool(name).is_some()
}

/// An op's input as a door offers it: the op's own arguments plus `project`.
pub fn input_with_project(spec: &OpSpec) -> Value {
    let mut input = spec.input.clone();
    if let Some(props) = input.get_mut("properties").and_then(Value::as_object_mut) {
        props.insert("project".into(), registry().project.clone());
    }
    input
}

/// The `studio_*` tool definitions the MCP companion lists, in registry order.
pub fn mcp_tools() -> Vec<Value> {
    registry()
        .ops
        .iter()
        .filter_map(|spec| {
            let tool = spec.tool.as_ref()?;
            Some(json!({
                "name": tool,
                "description": spec.description,
                "inputSchema": input_with_project(spec),
            }))
        })
        .collect()
}

/// The registry id of an op. No wildcard arm: a new [`StudioOp`] variant
/// does not compile until it is named here, and the tests then require it
/// in `studio_ops.json`.
pub fn op_name(op: &StudioOp) -> &'static str {
    match op {
        StudioOp::ListScenes => "list_scenes",
        StudioOp::ReadScene { .. } => "read_scene",
        StudioOp::ApplyCommands { .. } => "apply_commands",
        StudioOp::Build => "build",
        StudioOp::Publish { .. } => "publish",
        StudioOp::ListAssets => "list_assets",
        StudioOp::ImportAsset(_) => "import_asset",
        StudioOp::GenerateAsset(_) => "generate_asset",
        StudioOp::UpdateAsset { .. } => "update_asset",
        StudioOp::ConnectGenerator { .. } => "connect_generator",
        StudioOp::GeneratorOptions { .. } => "generator_options",
        StudioOp::RenderAsset(_) => "render_asset",
        StudioOp::ReadFlow => "read_flow",
        StudioOp::WriteFlow { .. } => "write_flow",
        StudioOp::ListSets => "list_sets",
        StudioOp::ReadSet { .. } => "read_set",
        StudioOp::CreateSet { .. } => "create_set",
        StudioOp::ApplySetCommands { .. } => "apply_set_commands",
        StudioOp::RenderSet(_) => "render_set",
        StudioOp::ModelOnce(_) => "model_once",
    }
}

/// Build an op from its registry id and its arguments (the input schema's
/// shape). `project`, a door argument, is ignored. The door for callers that
/// address ops by id — the CLI and the HTTP API.
pub fn parse(op: &str, arguments: &Value) -> Result<StudioOp, String> {
    if registry().find(op).is_none() {
        return Err(format!("unknown op `{op}` (studio op list shows them)"));
    }
    let mut args = match arguments {
        Value::Null => Map::new(),
        Value::Object(m) => m.clone(),
        _ => return Err(format!("{op}: arguments must be an object")),
    };
    args.remove("project");
    args.insert("op".into(), json!(op));
    serde_json::from_value(Value::Object(args)).map_err(|e| format!("{op}: {e}"))
}

/// Run an op by registry id against a project folder — parse, then
/// [`crate::studio_tools::run`]. An unknown id or bad arguments come back as
/// the usual `{ ok: false, note }`, like any other failure.
pub async fn call(root: std::path::PathBuf, op: &str, arguments: &Value) -> Value {
    match parse(op, arguments) {
        Ok(op) => crate::studio_tools::run(root, op).await,
        Err(note) => json!({ "ok": false, "note": note }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::companion::parse_studio_op;

    /// The smallest arguments the input schema accepts: each required field
    /// with a value of its type (an enum's first choice).
    fn minimal(schema: &Value) -> Value {
        let mut out = Map::new();
        for key in schema["required"].as_array().into_iter().flatten() {
            let key = key.as_str().unwrap();
            let prop = &schema["properties"][key];
            let value = if let Some(first) = prop["enum"].get(0) {
                first.clone()
            } else {
                match prop["type"].as_str() {
                    Some("string") => json!("x"),
                    Some("integer") | Some("number") => json!(1),
                    Some("boolean") => json!(false),
                    Some("array") => json!([{ "type": "x" }]),
                    _ => json!({}),
                }
            };
            out.insert(key.into(), value);
        }
        Value::Object(out)
    }

    #[test]
    fn registry_is_well_formed() {
        let reg = registry();
        let mut ops = std::collections::HashSet::new();
        let mut tools = std::collections::HashSet::new();
        for spec in &reg.ops {
            assert!(ops.insert(spec.op.as_str()), "duplicate op {}", spec.op);
            if let Some(tool) = &spec.tool {
                assert!(tool.starts_with("studio_"), "{tool}");
                assert!(tools.insert(tool.as_str()), "duplicate tool {tool}");
            }
            assert!(reg.groups.contains_key(&spec.group), "{}: group {}", spec.op, spec.group);
            assert!(!spec.title.is_empty() && !spec.description.is_empty(), "{}", spec.op);
            assert_eq!(spec.input["type"], "object", "{}", spec.op);
            assert!(spec.input["properties"].is_object(), "{}", spec.op);
            assert!(spec.input["properties"].get("project").is_none(), "{}: project is the door's", spec.op);
            assert_eq!(spec.output["properties"]["ok"]["const"], true, "{}", spec.op);
            for c in &spec.changes {
                assert!(["files", "assets", "build", "release"].contains(&c.as_str()), "{}: {c}", spec.op);
            }
            for u in &spec.uses {
                assert!(["genai", "blender", "model", "network", "shell"].contains(&u.as_str()), "{}: {u}", spec.op);
            }
        }
        assert_eq!(reg.failure["properties"]["ok"]["const"], false);
    }

    /// Every op in the list builds a [`StudioOp`] of the same id from its
    /// minimal arguments — through the generic door and, for MCP tools,
    /// through the companion's parser — so the list, the enum and the tools
    /// cannot drift apart. Together with [`op_name`]'s exhaustive match this
    /// also means every variant is listed.
    #[test]
    fn every_op_parses_to_its_variant() {
        let reg = registry();
        let mut named = std::collections::HashSet::new();
        for spec in &reg.ops {
            let mut args = minimal(&spec.input);
            // `url` or `file` — a rule the description states, since a tool's
            // top-level schema cannot say "one of" for every MCP client.
            if spec.op == "import_asset" {
                args["url"] = json!("https://example.com/a.png");
            }
            let op = parse(&spec.op, &args).unwrap_or_else(|e| panic!("{e} — args {args}"));
            assert_eq!(op_name(&op), spec.op);
            assert_eq!(serde_json::to_value(&op).unwrap()["op"], spec.op.as_str());
            named.insert(op_name(&op));
            if let Some(tool) = &spec.tool {
                let via_mcp = parse_studio_op(tool, &args).unwrap_or_else(|e| panic!("{tool}: {e} — args {args}"));
                assert_eq!(op_name(&via_mcp), spec.op, "{tool}");
            }
        }
        assert_eq!(named.len(), reg.ops.len());
    }

    #[test]
    fn mcp_tools_carry_project_and_skip_editor_ops() {
        let tools = mcp_tools();
        assert_eq!(tools.len(), registry().ops.iter().filter(|s| s.tool.is_some()).count());
        for t in &tools {
            assert!(t["inputSchema"]["properties"]["project"].is_object(), "{}", t["name"]);
        }
        assert!(is_mcp_tool("studio_list_assets"));
        assert!(!is_mcp_tool("studio_write_flow"));
        assert!(!is_mcp_tool("delegate_to_agent"));
    }

    #[test]
    fn parse_refuses_unknown_and_bad_arguments() {
        assert!(parse("nope", &Value::Null).unwrap_err().contains("unknown op"));
        assert!(parse("read_scene", &json!([1])).is_err());
        assert!(parse("read_scene", &json!({})).unwrap_err().contains("scene"));
        let op = parse("read_set", &json!({ "set": "cafe", "project": "/x" })).unwrap();
        assert_eq!(op, StudioOp::ReadSet { set: "cafe".into() });
    }

    #[tokio::test]
    async fn call_runs_or_reports() {
        let dir = tempfile::tempdir().unwrap();
        let listed = call(dir.path().to_path_buf(), "list_sets", &json!({})).await;
        assert_eq!(listed["ok"], true, "{listed}");
        let unknown = call(dir.path().to_path_buf(), "nope", &json!({})).await;
        assert_eq!(unknown["ok"], false);
        assert!(unknown["note"].as_str().unwrap().contains("unknown op"));
    }
}
