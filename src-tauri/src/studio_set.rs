//! The film set document (`outputs/film/sets/<set>.set.json`, decide
//! fs3-truth A): a 3D stage — floor, lights, props, actors, cameras with
//! paths — that the Studio's 3D set view, the agents (`studio_*_set` MCP
//! tools) and the Blender render ([`crate::studio_render`]) all read.
//!
//! The JSON file is the source of truth. Everything that changes it — a drag
//! in the 3D view, an agent batch — goes through [`apply_commands`], so both
//! obey the same rules: ids, bounds, atomic batches, unknown fields kept.
//! There is no TypeScript twin: the view sends commands and shows what comes
//! back.
//!
//! Space: metres, Y up, right-handed — the glTF convention, so a GLB lands
//! the way it was made. `rotation` is XYZ Euler degrees. A model's
//! `position` is where the middle of its footprint stands; `height` scales it
//! to that many metres tall.
//!
//! Time: seconds from 0 to `duration`. Cameras (and actors that move) carry
//! `keys`; between two keys values are blended with `ease` — `smooth`
//! (u²(3−2u) per segment, the default) or `linear`. Before the first key the
//! first holds, after the last the last. The 3D view and the render script
//! use this same rule ([`sample`]).

use serde_json::{json, Map, Value};

pub const MAX_ITEMS: usize = 200;
pub const MAX_KEYS: usize = 200;
pub const MAX_COMMANDS: usize = 200;
pub const KINDS: [&str; 4] = ["prop", "actor", "light", "camera"];
pub const LIGHT_TYPES: [&str; 4] = ["sun", "point", "spot", "area"];
pub const MOTIONS: [&str; 2] = ["still", "walk"];
pub const EASES: [&str; 2] = ["smooth", "linear"];
const COORD: f64 = 10_000.0;

pub type SetResult<T> = Result<T, String>;

/// The list a kind lives in.
pub fn list_of(kind: &str) -> Option<&'static str> {
    match kind {
        "prop" => Some("props"),
        "actor" => Some("actors"),
        "light" => Some("lights"),
        "camera" => Some("cameras"),
        _ => None,
    }
}

const LISTS: [&str; 4] = ["props", "actors", "lights", "cameras"];

fn object<'a>(value: &'a Value, what: &str) -> SetResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{what}: expected an object"))
}

fn text(value: &Value, what: &str, max: usize) -> SetResult<String> {
    match value.as_str() {
        Some(s) if !s.trim().is_empty() && s.chars().count() <= max => Ok(s.to_string()),
        _ => Err(format!("{what}: expected text (1–{max} chars)")),
    }
}

fn id(value: &Value, what: &str) -> SetResult<String> {
    let s = text(value, what, 100)?;
    if !crate::studio_scene::is_id(&s) {
        return Err(format!("{what}: ids use letters, digits, - and _ (max 100)"));
    }
    Ok(s)
}

fn number(value: &Value, what: &str, min: f64, max: f64) -> SetResult<f64> {
    match value.as_f64() {
        Some(n) if n.is_finite() && n >= min && n <= max => Ok(n),
        _ => Err(format!("{what}: expected a number between {min} and {max}")),
    }
}

/// A computed number: integral values serialize without a fraction, others
/// keep at most 4 decimals (a tenth of a millimetre).
pub fn num(n: f64) -> Value {
    let r = (n * 10_000.0).round() / 10_000.0;
    if r.fract() == 0.0 && r.abs() < 9.0e15 {
        json!(r as i64)
    } else {
        json!(r)
    }
}

fn vec3(value: &Value, what: &str, limit: f64) -> SetResult<Value> {
    let list = value
        .as_array()
        .filter(|l| l.len() == 3)
        .ok_or_else(|| format!("{what}: expected [x, y, z]"))?;
    let mut out = Vec::with_capacity(3);
    for (i, v) in list.iter().enumerate() {
        out.push(num(number(v, &format!("{what}[{i}]"), -limit, limit)?));
    }
    Ok(Value::Array(out))
}

fn color(value: &Value, what: &str) -> SetResult<Value> {
    let s = value.as_str().unwrap_or("");
    let hex = s.strip_prefix('#').unwrap_or("");
    if (hex.len() == 3 || hex.len() == 6) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(Value::String(s.to_ascii_lowercase()))
    } else {
        Err(format!("{what}: expected a colour like #ffcc66"))
    }
}

fn choice(value: Option<&Value>, what: &str, allowed: &[&str], default: &str) -> SetResult<Value> {
    match value {
        None | Some(Value::Null) => Ok(Value::String(default.into())),
        Some(v) => match v.as_str() {
            Some(s) if allowed.contains(&s) => Ok(Value::String(s.into())),
            _ => Err(format!("{what}: expected {}", allowed.join(", "))),
        },
    }
}

/// Seconds, kept to the millisecond so a key found by `t` is found again.
fn time(value: &Value, what: &str) -> SetResult<f64> {
    Ok((number(value, what, 0.0, 3600.0)? * 1000.0).round() / 1000.0)
}

/// `field` of `m` through `parse`, defaulted when absent.
fn field<F>(m: &Map<String, Value>, key: &str, default: Option<Value>, parse: F) -> SetResult<Option<Value>>
where
    F: Fn(&Value) -> SetResult<Value>,
{
    match m.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => parse(v).map(Some),
    }
}

fn parse_keys(value: Option<&Value>, what: &str, camera: bool) -> SetResult<Option<Value>> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let list = value
        .as_array()
        .filter(|l| l.len() <= MAX_KEYS)
        .ok_or_else(|| format!("{what}: expected a list of up to {MAX_KEYS} keys"))?;
    let mut keys = Vec::with_capacity(list.len());
    for (i, raw) in list.iter().enumerate() {
        let w = format!("{what}[{i}]");
        let k = object(raw, &w)?;
        let mut out = k.clone();
        out.insert("t".into(), num(time(k.get("t").unwrap_or(&Value::Null), &format!("{w}.t"))?));
        out.insert(
            "position".into(),
            vec3(k.get("position").unwrap_or(&Value::Null), &format!("{w}.position"), COORD)?,
        );
        if camera {
            out.insert(
                "target".into(),
                vec3(k.get("target").unwrap_or(&Value::Null), &format!("{w}.target"), COORD)?,
            );
            if let Some(roll) = k.get("roll").filter(|v| !v.is_null()) {
                out.insert("roll".into(), num(number(roll, &format!("{w}.roll"), -180.0, 180.0)?));
            }
        } else if let Some(yaw) = k.get("yaw").filter(|v| !v.is_null()) {
            out.insert("yaw".into(), num(number(yaw, &format!("{w}.yaw"), -3600.0, 3600.0)?));
        }
        keys.push(Value::Object(out));
    }
    keys.sort_by(|a, b| key_t(a).total_cmp(&key_t(b)));
    if keys.windows(2).any(|w| key_t(&w[0]) == key_t(&w[1])) {
        return Err(format!("{what}: two keys at the same time"));
    }
    Ok(Some(Value::Array(keys)))
}

pub fn key_t(key: &Value) -> f64 {
    key.get("t").and_then(Value::as_f64).unwrap_or(0.0)
}

/// One item of `kind`, validated and defaulted; unknown fields kept.
pub fn parse_item(kind: &str, value: &Value, what: &str) -> SetResult<Value> {
    let m = object(value, what)?;
    let mut out = m.clone();
    out.insert("id".into(), Value::String(id(m.get("id").unwrap_or(&Value::Null), &format!("{what}.id"))?));
    if let Some(name) = m.get("name").filter(|v| !v.is_null()) {
        out.insert("name".into(), Value::String(text(name, &format!("{what}.name"), 200)?));
    }
    let mut put = |key: &str, v: Option<Value>| match v {
        Some(v) => {
            out.insert(key.into(), v);
        }
        None => {
            out.remove(key);
        }
    };
    let at = |k: &str| format!("{what}.{k}");
    match kind {
        "prop" | "actor" => {
            put("asset", Some(Value::String(id(m.get("asset").unwrap_or(&Value::Null), &at("asset"))?)));
            put("position", field(m, "position", Some(json!([0, 0, 0])), |v| vec3(v, &at("position"), COORD))?);
            put("rotation", field(m, "rotation", Some(json!([0, 0, 0])), |v| vec3(v, &at("rotation"), 3600.0))?);
            put("height", field(m, "height", None, |v| number(v, &at("height"), 0.01, 1000.0).map(num))?);
            put("scale", field(m, "scale", None, |v| number(v, &at("scale"), 0.001, 1000.0).map(num))?);
            if kind == "actor" {
                put("motion", Some(choice(m.get("motion"), &at("motion"), &MOTIONS, "still")?));
                put("ease", Some(choice(m.get("ease"), &at("ease"), &EASES, "smooth")?));
                put("keys", parse_keys(m.get("keys"), &at("keys"), false)?);
            }
        }
        "light" => {
            let ty = choice(m.get("type"), &at("type"), &LIGHT_TYPES, "area")?;
            let default_power = if ty == "sun" { 3 } else { 500 };
            put("type", Some(ty));
            put("position", field(m, "position", Some(json!([3, 4, 3])), |v| vec3(v, &at("position"), COORD))?);
            put("target", field(m, "target", Some(json!([0, 1, 0])), |v| vec3(v, &at("target"), COORD))?);
            put("color", field(m, "color", Some(json!("#ffffff")), |v| color(v, &at("color")))?);
            put("power", field(m, "power", Some(json!(default_power)), |v| number(v, &at("power"), 0.0, 1_000_000.0).map(num))?);
            put("size", field(m, "size", None, |v| number(v, &at("size"), 0.01, 100.0).map(num))?);
        }
        "camera" => {
            put("lens", field(m, "lens", Some(json!(35)), |v| number(v, &at("lens"), 8.0, 300.0).map(num))?);
            put("ease", Some(choice(m.get("ease"), &at("ease"), &EASES, "smooth")?));
            let keys = parse_keys(m.get("keys"), &at("keys"), true)?;
            if keys.as_ref().and_then(Value::as_array).is_none_or(|k| k.is_empty()) {
                return Err(format!("{}: a camera needs at least one key {{ t, position, target }}", at("keys")));
            }
            put("keys", keys);
        }
        other => return Err(format!("Unknown kind {other}: expected {}", KINDS.join(", "))),
    }
    Ok(Value::Object(out))
}

/// Validate and normalize a set file.
pub fn parse_set(value: &Value) -> SetResult<Value> {
    let raw = object(value, "set")?;
    if let Some(schema) = raw.get("schema") {
        if schema.as_f64() != Some(1.0) {
            return Err(format!("Unsupported set schema {schema}"));
        }
    }
    let set_id = id(raw.get("id").unwrap_or(&Value::Null), "set.id")?;
    let mut out = raw.clone();
    out.insert("schema".into(), json!(1));
    out.insert("id".into(), Value::String(set_id.clone()));
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.chars().take(200).collect::<String>())
        .unwrap_or(set_id);
    out.insert("name".into(), Value::String(name));
    let fps = field(raw, "fps", Some(json!(24)), |v| number(v, "set.fps", 1.0, 60.0).map(|n| num(n.round())))?;
    out.insert("fps".into(), fps.unwrap_or(json!(24)));
    let duration = field(raw, "duration", Some(json!(15)), |v| number(v, "set.duration", 0.1, 600.0).map(num))?;
    out.insert("duration".into(), duration.unwrap_or(json!(15)));

    let frame = match raw.get("frame") {
        None | Some(Value::Null) => Map::new(),
        Some(f) => object(f, "set.frame")?.clone(),
    };
    let side = |k: &str, d: i64| -> SetResult<Value> {
        match frame.get(k) {
            None | Some(Value::Null) => Ok(json!(d)),
            Some(v) => number(v, &format!("set.frame.{k}"), 64.0, 4096.0).map(|n| json!((n as i64) & !1)),
        }
    };
    let mut f = frame.clone();
    f.insert("width".into(), side("width", 720)?);
    f.insert("height".into(), side("height", 1280)?);
    out.insert("frame".into(), Value::Object(f));

    let stage = match raw.get("stage") {
        None | Some(Value::Null) => Map::new(),
        Some(s) => object(s, "set.stage")?.clone(),
    };
    let mut st = stage.clone();
    match stage.get("floor") {
        Some(Value::Null) => {
            st.insert("floor".into(), Value::Null);
        }
        floor => {
            let fl = match floor {
                None => Map::new(),
                Some(v) => object(v, "set.stage.floor")?.clone(),
            };
            let mut o = fl.clone();
            o.insert(
                "size".into(),
                field(&fl, "size", Some(json!(30)), |v| number(v, "set.stage.floor.size", 0.1, 10_000.0).map(num))?
                    .unwrap_or(json!(30)),
            );
            o.insert(
                "color".into(),
                field(&fl, "color", Some(json!("#d9d2c5")), |v| color(v, "set.stage.floor.color"))?
                    .unwrap_or(json!("#d9d2c5")),
            );
            st.insert("floor".into(), Value::Object(o));
        }
    }
    st.insert(
        "background".into(),
        field(&stage, "background", Some(json!("#ebe6de")), |v| color(v, "set.stage.background"))?
            .unwrap_or(json!("#ebe6de")),
    );
    st.insert(
        "ambient".into(),
        field(&stage, "ambient", Some(json!(0.6)), |v| number(v, "set.stage.ambient", 0.0, 10.0).map(num))?
            .unwrap_or(json!(0.6)),
    );
    out.insert("stage".into(), Value::Object(st));

    let mut seen = std::collections::HashSet::new();
    let mut total = 0;
    for (list, kind) in LISTS.iter().zip(KINDS) {
        let items = match raw.get(*list) {
            None | Some(Value::Null) => Vec::new(),
            Some(v) => v.as_array().ok_or_else(|| format!("set.{list}: expected a list"))?.clone(),
        };
        total += items.len();
        if total > MAX_ITEMS {
            return Err(format!("A set holds up to {MAX_ITEMS} props, actors, lights and cameras"));
        }
        let mut parsed = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let p = parse_item(kind, item, &format!("{list}[{i}]"))?;
            let pid = p["id"].as_str().unwrap_or("").to_string();
            if !seen.insert(pid.clone()) {
                return Err(format!("Duplicate id {pid} (ids are unique across props, actors, lights and cameras)"));
            }
            parsed.push(p);
        }
        out.insert((*list).into(), Value::Array(parsed));
    }
    Ok(Value::Object(out))
}

/// A starter set: a floor, three lights and one camera looking at the middle.
pub fn starter(set_id: &str, name: Option<&str>) -> Value {
    json!({
        "schema": 1,
        "id": set_id,
        "name": name.filter(|n| !n.trim().is_empty()).unwrap_or(set_id),
        "fps": 24,
        "duration": 15,
        "frame": { "width": 720, "height": 1280 },
        "stage": { "floor": { "size": 30, "color": "#d9d2c5" }, "background": "#ebe6de", "ambient": 0.6 },
        "props": [],
        "actors": [],
        "lights": [
            { "id": "key", "type": "area", "position": [3, 4, 3], "target": [0, 1, 0], "power": 600, "size": 3 },
            { "id": "fill", "type": "area", "position": [-4, 2.5, 1], "target": [0, 1, 0], "power": 200, "size": 4 },
            { "id": "rim", "type": "area", "position": [0, 3, -4], "target": [0, 1, 0], "power": 300, "size": 3 }
        ],
        "cameras": [
            { "id": "cam_a", "name": "A", "lens": 35,
              "keys": [{ "t": 0, "position": [0, 1.5, 6], "target": [0, 1, 0] }] }
        ]
    })
}

/// Where an id lives: `(list, index)`.
fn locate(set: &Value, target: &str) -> Option<(&'static str, usize)> {
    LISTS.iter().find_map(|list| {
        set[*list]
            .as_array()?
            .iter()
            .position(|i| i["id"].as_str() == Some(target))
            .map(|i| (*list, i))
    })
}

fn kind_of_list(list: &str) -> &'static str {
    KINDS[LISTS.iter().position(|l| *l == list).unwrap_or(0)]
}

/// Shallow merge where `null` removes the field.
fn merge(base: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (k, v) in patch {
        if v.is_null() {
            base.remove(k);
        } else {
            base.insert(k.clone(), v.clone());
        }
    }
}

/// The ids a batch names, for the "changed" summary.
pub fn command_targets(commands: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for c in commands.as_array().into_iter().flatten() {
        let t = c.get("id").or_else(|| c.get("item").and_then(|i| i.get("id"))).and_then(Value::as_str);
        if let Some(t) = t {
            if !ids.iter().any(|i| i == t) {
                ids.push(t.to_string());
            }
        }
    }
    ids
}

/// Apply a batch atomically: one bad command and nothing changes.
///
/// - `set.update` `{ name?, fps?, duration?, frame?, stage? }` — `frame` and
///   `stage` merge shallowly.
/// - `add` `{ kind, item }`
/// - `update` `{ id, patch }` — shallow merge, `null` clears a field.
/// - `remove` `{ id }`
/// - `key.set` `{ id, key: { t, … } }` — a camera's or actor's key at `t`:
///   merged into the key already there, else added.
/// - `key.remove` `{ id, t }`
pub fn apply_commands(set: &Value, commands: &Value) -> SetResult<Value> {
    let list = commands
        .as_array()
        .filter(|c| !c.is_empty() && c.len() <= MAX_COMMANDS)
        .ok_or_else(|| format!("Provide between 1 and {MAX_COMMANDS} commands"))?;
    let mut next = parse_set(set)?;
    for (n, input) in list.iter().enumerate() {
        let c = object(input, &format!("commands[{n}]"))?;
        let kind = c.get("type").and_then(Value::as_str).unwrap_or("undefined");
        let target = || id(c.get("id").unwrap_or(&Value::Null), &format!("commands[{n}].id"));
        let found = |next: &Value, t: &str| locate(next, t).ok_or_else(|| format!("Not found: {t}"));
        match kind {
            "set.update" => {
                let o = next.as_object_mut().expect("set is an object");
                for key in ["name", "fps", "duration"] {
                    if let Some(v) = c.get(key) {
                        o.insert(key.into(), v.clone());
                    }
                }
                for key in ["frame", "stage"] {
                    if let Some(v) = c.get(key) {
                        let patch = object(v, key)?;
                        let mut base = o.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
                        merge(&mut base, patch);
                        o.insert(key.into(), Value::Object(base));
                    }
                }
                if let Some(bad) = c.keys().find(|k| !["type", "name", "fps", "duration", "frame", "stage"].contains(&k.as_str())) {
                    return Err(format!("set.update: unknown field {bad}"));
                }
            }
            "add" => {
                let k = c.get("kind").and_then(Value::as_str).unwrap_or("");
                let list = list_of(k).ok_or_else(|| format!("add.kind: expected {}", KINDS.join(", ")))?;
                let item = parse_item(k, c.get("item").unwrap_or(&Value::Null), "add.item")?;
                let new_id = item["id"].as_str().unwrap_or("").to_string();
                if locate(&next, &new_id).is_some() {
                    return Err(format!("Duplicate id {new_id}"));
                }
                next[list].as_array_mut().expect("normalized list").push(item);
            }
            "update" => {
                let t = target()?;
                let (list, i) = found(&next, &t)?;
                let patch = object(c.get("patch").unwrap_or(&Value::Null), "update.patch")?;
                if patch.get("id").is_some_and(|v| v.as_str() != Some(t.as_str())) {
                    return Err("update.patch: ids cannot change — remove and add instead".into());
                }
                let mut base = next[list][i].as_object().cloned().unwrap_or_default();
                merge(&mut base, patch);
                next[list][i] = parse_item(kind_of_list(list), &Value::Object(base), &t)?;
            }
            "remove" => {
                let t = target()?;
                let (list, i) = found(&next, &t)?;
                next[list].as_array_mut().expect("normalized list").remove(i);
            }
            "key.set" | "key.remove" => {
                let t = target()?;
                let (list, i) = found(&next, &t)?;
                if list != "cameras" && list != "actors" {
                    return Err(format!("{t} is a {} — only cameras and actors have keys", kind_of_list(list)));
                }
                let mut keys = next[list][i]["keys"].as_array().cloned().unwrap_or_default();
                if kind == "key.set" {
                    let key = object(c.get("key").unwrap_or(&Value::Null), "key.set.key")?;
                    let at = time(key.get("t").unwrap_or(&Value::Null), "key.set.key.t")?;
                    match keys.iter().position(|k| key_t(k) == at) {
                        Some(j) => {
                            let mut base = keys[j].as_object().cloned().unwrap_or_default();
                            merge(&mut base, key);
                            base.insert("t".into(), num(at));
                            keys[j] = Value::Object(base);
                        }
                        None => keys.push(Value::Object(key.clone())),
                    }
                } else {
                    let at = time(c.get("t").unwrap_or(&Value::Null), "key.remove.t")?;
                    let before = keys.len();
                    keys.retain(|k| key_t(k) != at);
                    if keys.len() == before {
                        return Err(format!("{t} has no key at {at}s"));
                    }
                }
                let mut item = next[list][i].as_object().cloned().unwrap_or_default();
                if keys.is_empty() {
                    item.remove("keys");
                } else {
                    item.insert("keys".into(), Value::Array(keys));
                }
                next[list][i] = parse_item(kind_of_list(list), &Value::Object(item), &t)?;
            }
            other => {
                return Err(format!(
                    "Unknown command: {other} (set.update, add, update, remove, key.set, key.remove)"
                ))
            }
        }
        next = parse_set(&next)?;
    }
    Ok(next)
}

/// What the register says about a material, for [`issues`].
pub struct Material {
    pub is_model: bool,
    pub rigged: bool,
}

/// Things that do not break the file but would spoil a render: the agent
/// reads these after every batch and fixes them.
pub fn issues(set: &Value, material: impl Fn(&str) -> Option<Material>) -> Vec<String> {
    let mut out = Vec::new();
    let duration = set["duration"].as_f64().unwrap_or(0.0);
    for list in ["props", "actors"] {
        for item in set[list].as_array().into_iter().flatten() {
            let iid = item["id"].as_str().unwrap_or("");
            let asset = item["asset"].as_str().unwrap_or("");
            match material(asset) {
                None => out.push(format!(
                    "{iid}: material `{asset}` is not in assets/manifest.json — it draws as a placeholder box (studio_list_assets)"
                )),
                Some(m) if !m.is_model => out.push(format!("{iid}: material `{asset}` is not a 3D model (GLB)")),
                Some(m) if list == "actors" && item["motion"] == "walk" && !m.rigged => out.push(format!(
                    "{iid}: walks, but `{asset}` has no skeleton — rig it first (studio_generate_asset kind rig)"
                )),
                _ => {}
            }
        }
    }
    for list in ["actors", "cameras"] {
        for item in set[list].as_array().into_iter().flatten() {
            let iid = item["id"].as_str().unwrap_or("");
            for k in item["keys"].as_array().into_iter().flatten() {
                if key_t(k) > duration {
                    out.push(format!("{iid}: key at {}s is after the set's duration {duration}s", key_t(k)));
                }
                if list == "cameras" && k["position"] == k["target"] {
                    out.push(format!("{iid}: key at {}s looks at its own position", key_t(k)));
                }
            }
        }
    }
    if set["cameras"].as_array().is_none_or(|c| c.is_empty()) {
        out.push("No camera — add one to render (add kind camera)".into());
    }
    if set["lights"].as_array().is_none_or(|l| l.is_empty()) && set["stage"]["ambient"].as_f64().unwrap_or(0.0) == 0.0 {
        out.push("No light and no ambient light — the render will be black".into());
    }
    out
}

fn lerp3(a: &Value, b: &Value, u: f64) -> Value {
    let g = |v: &Value, i: usize| v.get(i).and_then(Value::as_f64).unwrap_or(0.0);
    Value::Array((0..3).map(|i| num(g(a, i) + (g(b, i) - g(a, i)) * u)).collect())
}

/// A camera's (or actor's) `position` / `target` / `yaw` at `t` — the rule
/// the 3D view (`set.html`) and the render script (`studio_render.py`)
/// implement too. Kept here for tests and the render request's summary.
pub fn sample(item: &Value, t: f64) -> Option<Value> {
    let keys = item["keys"].as_array().filter(|k| !k.is_empty())?;
    let smooth = item["ease"].as_str() != Some("linear");
    let (a, b, u) = match keys.iter().position(|k| key_t(k) > t) {
        Some(0) => (&keys[0], &keys[0], 0.0),
        None => (keys.last()?, keys.last()?, 0.0),
        Some(j) => {
            let (a, b) = (&keys[j - 1], &keys[j]);
            let span = key_t(b) - key_t(a);
            let u = if span > 0.0 { (t - key_t(a)) / span } else { 0.0 };
            (a, b, if smooth { u * u * (3.0 - 2.0 * u) } else { u })
        }
    };
    let mut out = Map::new();
    for f in ["position", "target"] {
        if a.get(f).is_some() {
            out.insert(f.into(), lerp3(&a[f], &b[f], u));
        }
    }
    if a.get("target").is_some() {
        let (ra, rb) = (a["roll"].as_f64().unwrap_or(0.0), b["roll"].as_f64().unwrap_or(0.0));
        out.insert("roll".into(), num(ra + (rb - ra) * u));
    }
    let base_yaw = item["rotation"].get(1).and_then(Value::as_f64).unwrap_or(0.0);
    if item.get("rotation").is_some() {
        let ya = a["yaw"].as_f64().unwrap_or(base_yaw);
        let yb = b["yaw"].as_f64().unwrap_or(base_yaw);
        out.insert("yaw".into(), num(ya + (yb - ya) * u));
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_set() -> Value {
        let mut s = starter("cafe", Some("카페"));
        s["props"] = json!([{ "id": "room", "asset": "cafe-room", "height": 3, "note": "kept" }]);
        s["actors"] = json!([{ "id": "mina", "asset": "mina-rig", "position": [0, 0, 1], "motion": "walk", "height": 1.6,
            "keys": [{ "t": 4, "position": [1, 0, 0] }, { "t": 0, "position": [-1, 0, 0], "yaw": 90 }] }]);
        s["director"] = json!({ "mood": "warm" });
        s
    }

    #[test]
    fn parse_defaults_sorts_and_keeps_unknown_fields() {
        let s = parse_set(&sample_set()).unwrap();
        assert_eq!(s["director"]["mood"], "warm");
        assert_eq!(s["props"][0]["note"], "kept");
        assert_eq!(s["props"][0]["position"], json!([0, 0, 0]));
        assert_eq!(s["actors"][0]["keys"][0]["t"], 0, "keys sorted by time");
        assert_eq!(s["actors"][0]["ease"], "smooth");
        assert_eq!(s["frame"], json!({ "width": 720, "height": 1280 }));
        assert_eq!(s["lights"][0]["color"], "#ffffff");
        assert_eq!(s["stage"]["floor"]["size"], 30);
        // Idempotent.
        assert_eq!(parse_set(&s).unwrap(), s);
    }

    #[test]
    fn parse_refuses_bad_input() {
        for (patch, needle) in [
            (json!({ "schema": 2 }), "schema"),
            (json!({ "id": "a b" }), "set.id"),
            (json!({ "fps": 0 }), "set.fps"),
            (json!({ "cameras": [{ "id": "c", "keys": [] }] }), "at least one key"),
            (json!({ "cameras": [{ "id": "c", "keys": [{ "t": 0, "position": [0, 0], "target": [0, 0, 0] }] }] }), "[x, y, z]"),
            (json!({ "lights": [{ "id": "key", "type": "laser" }] }), "type"),
            (json!({ "props": [{ "id": "key", "asset": "x" }] }), "Duplicate id key"),
            (json!({ "props": [{ "id": "p" }] }), "asset"),
            (json!({ "stage": { "background": "red" } }), "colour"),
            (json!({ "actors": [{ "id": "a", "asset": "x", "keys": [{ "t": 1, "position": [0,0,0] }, { "t": 1, "position": [1,0,0] }] }] }), "same time"),
        ] {
            let mut s = sample_set();
            for (k, v) in patch.as_object().unwrap() {
                s[k] = v.clone();
            }
            let err = parse_set(&s).unwrap_err();
            assert!(err.contains(needle), "{err} ∌ {needle}");
        }
    }

    #[test]
    fn commands_apply_atomically() {
        let s = parse_set(&sample_set()).unwrap();
        let next = apply_commands(
            &s,
            &json!([
                { "type": "set.update", "name": "밤 카페", "stage": { "ambient": 0.2 } },
                { "type": "add", "kind": "camera", "item": { "id": "cam_b", "lens": 85,
                    "keys": [{ "t": 0, "position": [2, 1.6, 3], "target": [0, 1.4, 0] }] } },
                { "type": "update", "id": "room", "patch": { "position": [0, 0, -2], "height": null } },
                { "type": "key.set", "id": "cam_b", "key": { "t": 5, "position": [3, 1.6, 2], "target": [0, 1.4, 0] } },
                { "type": "key.set", "id": "cam_b", "key": { "t": 0, "position": [2, 2, 3] } },
                { "type": "key.remove", "id": "mina", "t": 4 },
                { "type": "remove", "id": "rim" }
            ]),
        )
        .unwrap();
        assert_eq!(next["name"], "밤 카페");
        assert_eq!(next["stage"]["ambient"], 0.2);
        assert_eq!(next["stage"]["floor"]["size"], 30, "stage merges");
        assert_eq!(next["props"][0]["position"], json!([0, 0, -2]));
        assert!(next["props"][0].get("height").is_none(), "null clears");
        let cam = &next["cameras"][1];
        assert_eq!(cam["keys"].as_array().unwrap().len(), 2);
        assert_eq!(cam["keys"][0]["position"], json!([2, 2, 3]), "key.set merges at the same t");
        assert_eq!(cam["keys"][0]["target"], json!([0, 1.4, 0]));
        assert_eq!(next["actors"][0]["keys"].as_array().unwrap().len(), 1);
        assert_eq!(next["lights"].as_array().unwrap().len(), 2);

        for (bad, needle) in [
            (json!([{ "type": "update", "id": "room", "patch": { "position": [0, 0, 1] } }, { "type": "update", "id": "ghost", "patch": {} }]), "Not found: ghost"),
            (json!([{ "type": "add", "kind": "prop", "item": { "id": "mina", "asset": "x" } }]), "Duplicate id mina"),
            (json!([{ "type": "key.set", "id": "room", "key": { "t": 1, "position": [0, 0, 0] } }]), "only cameras and actors"),
            (json!([{ "type": "key.remove", "id": "cam_a", "t": 0 }]), "at least one key"),
            (json!([{ "type": "update", "id": "room", "patch": { "id": "hall" } }]), "ids cannot change"),
            (json!([{ "type": "set.update", "colour": "x" }]), "unknown field"),
            (json!([{ "type": "explode" }]), "Unknown command"),
            (json!([]), "between 1"),
        ] {
            let err = apply_commands(&s, &bad).unwrap_err();
            assert!(err.contains(needle), "{err} ∌ {needle}");
        }
        assert_eq!(s["props"][0]["position"], json!([0, 0, 0]), "input untouched");
        assert_eq!(command_targets(&json!([{ "type": "remove", "id": "a" }, { "type": "add", "item": { "id": "b" } }])), ["a", "b"]);
    }

    #[test]
    fn issues_name_what_would_spoil_a_render() {
        let mut s = parse_set(&sample_set()).unwrap();
        s["cameras"][0]["keys"][0]["target"] = s["cameras"][0]["keys"][0]["position"].clone();
        s["actors"][0]["keys"][1]["t"] = json!(20);
        let found = issues(&s, |id| match id {
            "mina-rig" => Some(Material { is_model: true, rigged: false }),
            _ => None,
        });
        let all = found.join("\n");
        assert!(all.contains("room: material `cafe-room` is not in"), "{all}");
        assert!(all.contains("mina: walks"), "{all}");
        assert!(all.contains("after the set's duration"), "{all}");
        assert!(all.contains("looks at its own position"), "{all}");
        let mut empty = parse_set(&starter("e", None)).unwrap();
        empty["cameras"] = json!([]);
        empty["lights"] = json!([]);
        empty["stage"]["ambient"] = json!(0);
        assert_eq!(issues(&empty, |_| None).len(), 2);
    }

    #[test]
    fn sample_holds_ends_and_eases_between() {
        let cam = json!({ "ease": "smooth", "keys": [
            { "t": 1, "position": [0, 0, 0], "target": [0, 0, 0] },
            { "t": 3, "position": [10, 0, 0], "target": [0, 2, 0] }
        ] });
        assert_eq!(sample(&cam, 0.0).unwrap()["position"], json!([0, 0, 0]));
        assert_eq!(sample(&cam, 2.0).unwrap()["position"], json!([5, 0, 0]), "half way");
        assert_eq!(sample(&cam, 1.5).unwrap()["position"], json!([1.5625, 0, 0]), "u=.25 → .15625");
        assert_eq!(sample(&cam, 9.0).unwrap()["target"], json!([0, 2, 0]));
        let mut lin = cam.clone();
        lin["ease"] = json!("linear");
        assert_eq!(sample(&lin, 1.5).unwrap()["position"], json!([2.5, 0, 0]));
        let actor = json!({ "rotation": [0, 30, 0], "ease": "linear", "keys": [
            { "t": 0, "position": [0, 0, 0], "yaw": 90 }, { "t": 2, "position": [2, 0, 0] }
        ] });
        assert_eq!(sample(&actor, 1.0).unwrap()["yaw"], 60, "missing yaw = the actor's own");
        assert!(sample(&json!({}), 0.0).is_none());
    }
}
