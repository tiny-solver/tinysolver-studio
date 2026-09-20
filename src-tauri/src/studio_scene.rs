//! Rust twin of `src/lib/studio/document.ts`: validation and command
//! application for a Codeg Studio scene file
//! (`outputs/game/content/<scene>.studio.json`).
//!
//! The editor, the engine and the agent share one file, and the agent's MCP
//! tools (`studio_apply_scene_commands`) run through this module so a batch
//! from an agent obeys the same rules as a drag in the editor: ids, bounds,
//! anchors, atomic batches, unknown fields preserved. Keep the two files in
//! step — the TypeScript one is the reference; tests here mirror its cases.
//!
//! Values are kept as `serde_json::Value` so everything the editor does not
//! understand (`logic`, engine props, grids) round-trips untouched. Numbers
//! that pass validation are copied as written (an integer stays an integer).

use serde_json::{json, Map, Value};

pub const MAX_NODES: usize = 1000;
pub const MAX_ASSETS: usize = 500;
pub const MAX_COMMANDS: usize = 200;
pub const MAX_ACTION_STEPS: usize = 100;
const COORD: f64 = 1_000_000.0;
pub const ANCHORS: [&str; 3] = ["top-left", "center", "bottom-center"];
const TRANSFORM_KEYS: [&str; 6] = ["x", "y", "w", "h", "anchor", "z"];

pub type SceneResult<T> = Result<T, String>;

fn object<'a>(value: &'a Value, what: &str) -> SceneResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

fn string(value: &Value, what: &str, max: usize) -> SceneResult<String> {
    match value.as_str() {
        Some(s) if !s.is_empty() && s.chars().count() <= max => Ok(s.to_string()),
        _ => Err(format!("{what}: expected text (1–{max} chars)")),
    }
}

pub fn is_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn id(value: &Value, what: &str) -> SceneResult<String> {
    let s = string(value, what, 200)?;
    if !is_id(&s) {
        return Err(format!("{what}: ids use letters, digits, - and _ (max 100)"));
    }
    Ok(s)
}

/// Validate a number and hand back the original JSON value so `540` does not
/// become `540.0` on disk.
fn number(value: &Value, what: &str, min: f64, max: f64) -> SceneResult<Value> {
    match value.as_f64() {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(value.clone()),
        _ => Err(format!("{what}: expected a number between {min} and {max}")),
    }
}

fn as_f64(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

/// A computed coordinate: integral values serialize without a fraction.
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

pub fn parse_transform(value: &Value, what: &str) -> SceneResult<Value> {
    let t = object(value, what)?;
    let anchor = match t.get("anchor") {
        None | Some(Value::Null) => "top-left".to_string(),
        Some(a) => match a.as_str() {
            Some(a) if ANCHORS.contains(&a) => a.to_string(),
            _ => return Err(format!("{what}.anchor: expected {}", ANCHORS.join(", "))),
        },
    };
    let field = |key: &str| t.get(key).unwrap_or(&Value::Null);
    let mut out = Map::new();
    out.insert("x".into(), number(field("x"), &format!("{what}.x"), -COORD, COORD)?);
    out.insert("y".into(), number(field("y"), &format!("{what}.y"), -COORD, COORD)?);
    out.insert("w".into(), number(field("w"), &format!("{what}.w"), 1.0, COORD)?);
    out.insert("h".into(), number(field("h"), &format!("{what}.h"), 1.0, COORD)?);
    out.insert("anchor".into(), Value::String(anchor));
    out.insert(
        "z".into(),
        match t.get("z") {
            None => json!(0),
            Some(z) => number(z, &format!("{what}.z"), -COORD, COORD)?,
        },
    );
    Ok(Value::Object(out))
}

fn parse_asset(value: &Value, index: usize) -> SceneResult<Value> {
    let what = format!("assets[{index}]");
    let a = object(value, &what)?;
    let file = string(
        a.get("file").unwrap_or(&Value::Null),
        &format!("{what}.file"),
        500,
    )?;
    if file.starts_with('/') || file.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(format!("{what}.file: must be relative to assets/"));
    }
    let mut out = a.clone();
    out.insert(
        "id".into(),
        Value::String(id(a.get("id").unwrap_or(&Value::Null), &format!("{what}.id"))?),
    );
    out.insert("file".into(), Value::String(file));
    out.insert(
        "width".into(),
        number(
            a.get("width").unwrap_or(&Value::Null),
            &format!("{what}.width"),
            1.0,
            16384.0,
        )?,
    );
    out.insert(
        "height".into(),
        number(
            a.get("height").unwrap_or(&Value::Null),
            &format!("{what}.height"),
            1.0,
            16384.0,
        )?,
    );
    if let Some(missing) = a.get("missing") {
        out.insert("missing".into(), Value::Bool(truthy(missing)));
    }
    Ok(Value::Object(out))
}

/// JavaScript truthiness for the `missing` flag (`Boolean(a.missing)`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn parse_node(value: &Value, index: usize) -> SceneResult<Value> {
    let what = format!("nodes[{index}]");
    let n = object(value, &what)?;
    let props = match n.get("props") {
        None => Map::new(),
        Some(p) => object(p, &format!("{what}.props"))?.clone(),
    };
    let parent = match n.get("parent") {
        None => "root".to_string(),
        Some(p) => string(p, &format!("{what}.parent"), 200)?,
    };
    let mut out = Map::new();
    out.insert(
        "id".into(),
        Value::String(id(n.get("id").unwrap_or(&Value::Null), &format!("{what}.id"))?),
    );
    out.insert("parent".into(), Value::String(parent));
    out.insert(
        "type".into(),
        Value::String(string(
            n.get("type").unwrap_or(&Value::Null),
            &format!("{what}.type"),
            40,
        )?),
    );
    out.insert(
        "transform".into(),
        parse_transform(
            n.get("transform").unwrap_or(&Value::Null),
            &format!("{what}.transform"),
        )?,
    );
    out.insert("props".into(), Value::Object(props));
    Ok(Value::Object(out))
}

/// Validate and normalize a scene file. Unknown top-level and document
/// fields are preserved; core fields are checked and defaulted.
pub fn parse_scene(value: &Value) -> SceneResult<Value> {
    let raw = object(value, "scene")?;
    if let Some(schema) = raw.get("schema") {
        if schema.as_i64() != Some(1) && schema.as_f64() != Some(1.0) {
            return Err(format!("Unsupported scene schema {schema}"));
        }
    }
    let scene_id = id(raw.get("id").unwrap_or(&Value::Null), "scene.id")?;
    let doc = object(raw.get("document").unwrap_or(&Value::Null), "scene.document")?;
    let container = object(
        doc.get("container").unwrap_or(&Value::Null),
        "scene.document.container",
    )?;
    let nodes_raw = doc
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or("scene.document.nodes: expected a list")?;
    if nodes_raw.len() > MAX_NODES {
        return Err(format!("A scene supports up to {MAX_NODES} nodes"));
    }
    let empty = Vec::new();
    let assets_raw = match doc.get("assets") {
        None => &empty,
        Some(a) => a
            .as_array()
            .ok_or("scene.document.assets: expected a list")?,
    };
    if assets_raw.len() > MAX_ASSETS {
        return Err(format!("A scene supports up to {MAX_ASSETS} assets"));
    }

    let assets = assets_raw
        .iter()
        .enumerate()
        .map(|(i, a)| parse_asset(a, i))
        .collect::<SceneResult<Vec<_>>>()?;
    if has_duplicate_ids(&assets) {
        return Err("Duplicate asset id".into());
    }
    let nodes = nodes_raw
        .iter()
        .enumerate()
        .map(|(i, n)| parse_node(n, i))
        .collect::<SceneResult<Vec<_>>>()?;
    if has_duplicate_ids(&nodes) {
        return Err("Duplicate node id".into());
    }

    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.chars().take(200).collect::<String>())
        .unwrap_or_else(|| scene_id.clone());

    let mut out: Map<String, Value> = raw
        .iter()
        .filter(|(k, _)| !["schema", "id", "name", "document"].contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    out.insert("schema".into(), json!(1));
    out.insert("id".into(), Value::String(scene_id));
    out.insert("name".into(), Value::String(name));

    let mut document: Map<String, Value> = doc
        .iter()
        .filter(|(k, _)| !["container", "assets", "nodes"].contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    document.insert(
        "container".into(),
        json!({
            "width": number(
                container.get("width").unwrap_or(&Value::Null),
                "container.width", 16.0, 16384.0
            )?,
            "height": number(
                container.get("height").unwrap_or(&Value::Null),
                "container.height", 16.0, 16384.0
            )?,
        }),
    );
    document.insert("assets".into(), Value::Array(assets));
    document.insert("nodes".into(), Value::Array(nodes));
    out.insert("document".into(), Value::Object(document));
    Ok(Value::Object(out))
}

fn has_duplicate_ids(items: &[Value]) -> bool {
    let mut seen = std::collections::HashSet::new();
    items
        .iter()
        .filter_map(|v| v.get("id").and_then(Value::as_str))
        .any(|id| !seen.insert(id))
}

fn parse_steps(value: &Value) -> SceneResult<Value> {
    let list = value
        .as_array()
        .filter(|l| l.len() <= MAX_ACTION_STEPS)
        .ok_or_else(|| format!("steps: expected a list of up to {MAX_ACTION_STEPS}"))?;
    for (index, raw) in list.iter().enumerate() {
        let step = object(raw, &format!("steps[{index}]"))?;
        string(
            step.get("op").unwrap_or(&Value::Null),
            &format!("steps[{index}].op"),
            40,
        )?;
    }
    Ok(value.clone())
}

fn node_id(node: &Value) -> &str {
    node.get("id").and_then(Value::as_str).unwrap_or("")
}

fn node_z(node: &Value) -> f64 {
    node.get("transform")
        .and_then(|t| t.get("z"))
        .map(as_f64)
        .unwrap_or(0.0)
}

/// The ids a batch names, for the tool's "changed" summary. Best effort:
/// validation happens in [`apply_commands`].
pub fn command_targets(commands: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for command in commands.as_array().into_iter().flatten() {
        let target = command
            .get("id")
            .or_else(|| command.get("node").and_then(|n| n.get("id")))
            .and_then(Value::as_str);
        if let Some(t) = target {
            if !ids.iter().any(|i| i == t) {
                ids.push(t.to_string());
            }
        }
    }
    ids
}

/// Apply a batch atomically to an already-normalized scene: any invalid
/// command leaves the input untouched (the caller keeps its copy).
pub fn apply_commands(scene: &Value, commands: &Value) -> SceneResult<Value> {
    let list = commands
        .as_array()
        .filter(|c| !c.is_empty() && c.len() <= MAX_COMMANDS)
        .ok_or_else(|| format!("Provide between 1 and {MAX_COMMANDS} commands"))?;
    let mut next = scene.clone();
    for input in list {
        let command = object(input, "command")?;
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        let nodes = next
            .get_mut("document")
            .and_then(|d| d.get_mut("nodes"))
            .and_then(Value::as_array_mut)
            .ok_or("scene.document.nodes: expected a list")?;
        match kind {
            "scene.update" => {
                if let Some(name) = command.get("name") {
                    let name = string(name, "name", 200)?;
                    next.as_object_mut()
                        .expect("scene is an object")
                        .insert("name".into(), Value::String(name));
                }
            }
            "action.set" | "action.remove" => {
                let name = id(command.get("name").unwrap_or(&Value::Null), "action name")?;
                let steps = if kind == "action.set" {
                    Some(parse_steps(command.get("steps").unwrap_or(&Value::Null))?)
                } else {
                    None
                };
                // `logic` is engine-owned and may be absent or oddly shaped;
                // anything that is not an object is replaced, the rest kept.
                let scene = next.as_object_mut().expect("scene is an object");
                let logic = scene
                    .entry("logic")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !logic.is_object() {
                    *logic = Value::Object(Map::new());
                }
                let actions = logic
                    .as_object_mut()
                    .expect("logic is an object")
                    .entry("actions")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !actions.is_object() {
                    *actions = Value::Object(Map::new());
                }
                let actions = actions.as_object_mut().expect("actions is an object");
                match steps {
                    Some(steps) => {
                        actions.insert(name, steps);
                    }
                    None => {
                        actions.remove(&name);
                    }
                }
            }
            "node.add" => {
                let node = parse_node(command.get("node").unwrap_or(&Value::Null), nodes.len())?;
                nodes.push(node);
            }
            "node.update" | "node.remove" | "node.reorder" => {
                let target = string(command.get("id").unwrap_or(&Value::Null), "command.id", 200)?;
                let index = nodes
                    .iter()
                    .position(|n| node_id(n) == target)
                    .ok_or_else(|| format!("Node not found: {target}"))?;
                match kind {
                    "node.update" => {
                        if let Some(patch) = command.get("transform") {
                            let patch = object(patch, "transform")?;
                            if let Some(bad) = patch.keys().find(|k| !TRANSFORM_KEYS.contains(&k.as_str())) {
                                return Err(format!("transform.{bad}: unknown field"));
                            }
                            let mut merged = nodes[index]
                                .get("transform")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            for (k, v) in patch {
                                merged.insert(k.clone(), v.clone());
                            }
                            let transform = parse_transform(&Value::Object(merged), "transform")?;
                            nodes[index]["transform"] = transform;
                        }
                        if let Some(patch) = command.get("props") {
                            let patch = object(patch, "props")?;
                            let props = nodes[index]
                                .get_mut("props")
                                .and_then(Value::as_object_mut)
                                .ok_or("props: expected an object")?;
                            for (k, v) in patch {
                                props.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    "node.remove" => {
                        let mut doomed: Vec<String> = vec![target.clone()];
                        let mut grew = true;
                        while grew {
                            grew = false;
                            for n in nodes.iter() {
                                let id = node_id(n).to_string();
                                let parent = n.get("parent").and_then(Value::as_str).unwrap_or("");
                                if !doomed.contains(&id) && doomed.iter().any(|d| d == parent) {
                                    doomed.push(id);
                                    grew = true;
                                }
                            }
                        }
                        nodes.retain(|n| !doomed.iter().any(|d| d == node_id(n)));
                    }
                    _ => {
                        let zs: Vec<f64> = nodes.iter().map(node_z).collect();
                        let z = match command.get("direction").and_then(Value::as_str) {
                            Some("forward") => zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) + 1.0,
                            Some("backward") => zs.iter().cloned().fold(f64::INFINITY, f64::min) - 1.0,
                            _ => return Err("direction: expected forward or backward".into()),
                        };
                        nodes[index]["transform"]["z"] = num(z);
                    }
                }
            }
            other => return Err(format!("Unknown command: {other}")),
        }
    }
    parse_scene(&next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "schema": 1,
            "id": "main",
            "name": "첫 장면",
            "document": {
                "container": { "width": 1080, "height": 1920 },
                "grid": { "cell": 40 },
                "assets": [
                    { "id": "hero_idle", "file": "characters/hero/hero_idle_120x180.png",
                      "width": 120, "height": 180, "missing": true, "tags": ["hero"] }
                ],
                "nodes": [
                    { "id": "bg", "parent": "root", "type": "rect",
                      "transform": { "x": 0, "y": 0, "w": 1080, "h": 1920 },
                      "props": { "color": "#101318" } },
                    { "id": "hero", "parent": "root", "type": "sprite",
                      "transform": { "x": 540, "y": 1500, "w": 120, "h": 180, "anchor": "bottom-center", "z": 20 },
                      "props": { "asset": "hero_idle", "interactive": true, "onClick": "act_hero" } },
                    { "id": "hint", "parent": "hero", "type": "text",
                      "transform": { "x": 0, "y": -60, "w": 300, "h": 40, "z": 30 },
                      "props": { "text": "hi", "visible": false } }
                ]
            },
            "logic": { "actions": { "act_hero": [{ "op": "say", "text": "안녕" }] } }
        })
    }

    #[test]
    fn parse_preserves_unknown_fields_and_defaults_core() {
        let scene = parse_scene(&sample()).unwrap();
        assert_eq!(scene["logic"]["actions"]["act_hero"][0]["op"], "say");
        assert_eq!(scene["document"]["grid"]["cell"], 40);
        assert_eq!(scene["document"]["assets"][0]["tags"][0], "hero");
        // Defaults: anchor + z on the first node, integers stay integers.
        let bg = &scene["document"]["nodes"][0];
        assert_eq!(bg["transform"]["anchor"], "top-left");
        assert_eq!(bg["transform"]["z"], 0);
        assert_eq!(serde_json::to_string(&bg["transform"]["w"]).unwrap(), "1080");
    }

    #[test]
    fn parse_rejects_bad_input() {
        let mut s = sample();
        s["document"]["nodes"][1]["id"] = json!("bg");
        assert_eq!(parse_scene(&s).unwrap_err(), "Duplicate node id");

        let mut s = sample();
        s["document"]["assets"][0]["file"] = json!("../secret.png");
        assert!(parse_scene(&s).unwrap_err().contains("relative to assets/"));

        let mut s = sample();
        s["schema"] = json!(2);
        assert!(parse_scene(&s).unwrap_err().contains("Unsupported scene schema"));

        let mut s = sample();
        s["document"]["nodes"][0]["transform"]["anchor"] = json!("middle");
        assert!(parse_scene(&s).unwrap_err().contains("anchor"));

        let mut s = sample();
        s["id"] = json!("bad id!");
        assert!(parse_scene(&s).unwrap_err().contains("scene.id"));
    }

    #[test]
    fn apply_is_atomic_and_matches_the_editor_rules() {
        let scene = parse_scene(&sample()).unwrap();
        let next = apply_commands(
            &scene,
            &json!([
                { "type": "node.update", "id": "hero", "transform": { "x": 600 }, "props": { "flip": true } },
                { "type": "scene.update", "name": "Room" },
                { "type": "node.add", "node": { "id": "sign", "type": "rect",
                    "transform": { "x": 10, "y": 10, "w": 50, "h": 50 }, "props": { "color": "#fff" } } },
                { "type": "node.reorder", "id": "bg", "direction": "forward" }
            ]),
        )
        .unwrap();
        assert_eq!(next["name"], "Room");
        let nodes = next["document"]["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[1]["transform"]["x"], 600);
        assert_eq!(nodes[1]["transform"]["y"], 1500, "untouched fields stay");
        assert_eq!(nodes[1]["props"]["flip"], true);
        assert_eq!(nodes[1]["props"]["onClick"], "act_hero", "props merge shallowly");
        assert_eq!(nodes[0]["transform"]["z"], 31, "forward = max z + 1");
        assert_eq!(next["logic"]["actions"]["act_hero"][0]["text"], "안녕");

        // One bad command → nothing applied, original returned untouched.
        let err = apply_commands(
            &scene,
            &json!([
                { "type": "node.update", "id": "hero", "transform": { "x": 1 } },
                { "type": "node.update", "id": "nope", "transform": { "x": 1 } }
            ]),
        )
        .unwrap_err();
        assert_eq!(err, "Node not found: nope");
        assert_eq!(scene["document"]["nodes"][1]["transform"]["x"], 540);

        assert!(apply_commands(&scene, &json!([])).unwrap_err().contains("between 1 and"));
        assert!(apply_commands(&scene, &json!([{ "type": "node.update", "id": "hero", "transform": { "rotate": 1 } }]))
            .unwrap_err()
            .contains("transform.rotate"));
        assert!(apply_commands(&scene, &json!([{ "type": "node.explode", "id": "hero" }]))
            .unwrap_err()
            .contains("Unknown command: node.explode"));
    }

    #[test]
    fn action_commands_edit_logic_and_keep_the_rest() {
        let mut raw = sample();
        raw["logic"]["flags"] = json!({ "intro": true });
        let scene = parse_scene(&raw).unwrap();
        let next = apply_commands(
            &scene,
            &json!([
                { "type": "action.set", "name": "act_open", "steps": [
                    { "op": "swapAsset", "id": "hero", "asset": "hero_idle" },
                    { "op": "add", "key": "coins", "value": 3, "if": { "key": "hasKey" } }
                ] },
                { "type": "action.remove", "name": "act_hero" }
            ]),
        )
        .unwrap();
        assert_eq!(next["logic"]["actions"]["act_open"][1]["if"]["key"], "hasKey");
        assert!(next["logic"]["actions"].get("act_hero").is_none());
        assert_eq!(next["logic"]["flags"]["intro"], true, "other logic fields stay");
        assert_eq!(scene["logic"]["actions"]["act_hero"][0]["op"], "say", "input untouched");

        // A scene with no logic (or a broken one) gets a fresh object.
        let mut bare = sample();
        bare.as_object_mut().unwrap().remove("logic");
        let bare = parse_scene(&bare).unwrap();
        let made = apply_commands(&bare, &json!([{ "type": "action.set", "name": "hi", "steps": [{ "op": "say", "text": "hi" }] }])).unwrap();
        assert_eq!(made["logic"]["actions"]["hi"][0]["text"], "hi");

        for (bad, needle) in [
            (json!([{ "type": "action.set", "name": "bad name", "steps": [] }]), "action name"),
            (json!([{ "type": "action.set", "name": "a", "steps": [{ "id": "x" }] }]), "steps[0].op"),
            (json!([{ "type": "action.set", "name": "a", "steps": "say hi" }]), "steps"),
            (json!([{ "type": "action.set", "name": "a" }]), "steps"),
        ] {
            let err = apply_commands(&scene, &bad).unwrap_err();
            assert!(err.contains(needle), "{err}");
        }
    }

    #[test]
    fn remove_cascades_to_children() {
        let scene = parse_scene(&sample()).unwrap();
        let next = apply_commands(&scene, &json!([{ "type": "node.remove", "id": "hero" }])).unwrap();
        let ids: Vec<&str> = next["document"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(node_id)
            .collect();
        assert_eq!(ids, vec!["bg"]);
        assert_eq!(command_targets(&json!([{ "type": "node.remove", "id": "hero" }, { "type": "node.add", "node": { "id": "x" } }])), vec!["hero", "x"]);
    }
}
