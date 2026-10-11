//! Flows — the Studio's high-level work, as documents that wire parts together.
//!
//! A flow is one file, `<project>/flows/<id>.flow.json` (studio-layers ②).
//! People, agents and the web view read and write the same file, the way they
//! share scene documents. It opens with `want` — what is wanted, in one line,
//! with good and bad examples — and then lists steps. A step is a node:
//!
//! | kind       | what it does                                                  |
//! |------------|---------------------------------------------------------------|
//! | `op`       | one Studio part, by its registry id                           |
//! | `model`    | one model call — a part too (`model_once` unless `op` says)   |
//! | `human`    | stops the run and shows a card; the answer is the output      |
//! | `flow`     | another flow, run inline as one node                          |
//! | `set`      | a value built from earlier outputs (no call), a list filtered |
//! |            | by `keep`                                                     |
//! | `agent`    | an agent loop over ACP — L4; refused until then               |
//! | `seq`      | its steps in order                                            |
//! | `parallel` | its branches at once                                          |
//! | `each`     | its steps once per item of a list (or of a product), at once, |
//! |            | collected into a list                                         |
//! | `if`       | `then` or `else` on a condition                               |
//! | `repeat`   | its steps until a condition holds, at most `max` times        |
//!
//! Arguments reach earlier results with `${…}`: `${inputs.models}`,
//! `${score.output.best}`, `${gens.*.image.output.path}` (`*` maps over a list).
//! A string that is exactly one `${…}` takes the value as is; inside longer
//! text the value is spliced in as text.
//!
//! Every run is recorded under `<project>/runs/<flow>/<run>/run.json`: the flow
//! as it was, the inputs, and per node what went in, what came out, who
//! answered, how long it took, what it cost and its log. A `human` node leaves
//! a card there and the run waits; [`answer`] stores the answer and the run
//! resumes by replaying — every leaf whose input is unchanged reuses its
//! record, so nothing is called twice. The same replay lets a new run start
//! from an earlier one (`from_run`): change one node, and only that node and
//! what follows from it is called again; the two runs then sit side by side
//! ([`compare`]).
//!
//! The executor does not know the parts. It calls them through [`Parts`] —
//! the server gives it the registry, tests give it fakes — and follows the
//! studio rule: a part's `{ ok: false, note }` fails the node with that note.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use async_trait::async_trait;
use futures::future::BoxFuture;
use futures::{stream, FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Where the flows live, from the project root.
pub const FLOWS_DIR: &str = "flows";
/// Where the runs are recorded, from the project root.
pub const RUNS_DIR: &str = "runs";
const FLOW_SUFFIX: &str = ".flow.json";
const RUN_FILE: &str = "run.json";
/// The first flow (studio-layers ②): want → materials → styles × models →
/// judge → the owner's pick → a bible card. Shipped as an example; a project
/// gets it with `flow_put`.
pub const STYLE_FIND_FLOW: &str = include_str!("studio_flows/style-find.flow.json");
/// The part a `model` node calls unless it names another.
pub const MODEL_OP: &str = "model_once";
/// How many items of an `each` run at once unless it says.
const DEFAULT_EACH_LIMIT: usize = 4;
const MAX_EACH_LIMIT: usize = 32;
const MAX_REPEAT: u32 = 50;
/// How deep `flow` nodes may nest (a flow that calls itself stops here).
const MAX_FLOW_DEPTH: usize = 8;

// ─── The document ───

/// `flows/<id>.flow.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowDoc {
    pub schema: u32,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub want: Want,
    /// Default inputs; a run may override any of them. `${inputs.<name>}`.
    #[serde(default)]
    pub inputs: Map<String, Value>,
    pub steps: Vec<Node>,
    /// What the run hands back — usually `${<last node>.output}`. Without it,
    /// the last step's output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// What is wanted — the head of every flow and of every run's record.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Want {
    pub text: String,
    #[serde(default)]
    pub good: Vec<String>,
    #[serde(default)]
    pub bad: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    /// A line for people reading the flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// On failure, record it and go on with `{ ok: false, note }` as the
    /// output instead of failing the run (one bad picture out of twenty).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_going: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeKind {
    Op {
        op: String,
        #[serde(default)]
        args: Value,
    },
    Model {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        op: Option<String>,
        #[serde(default)]
        args: Value,
    },
    Human {
        /// The question on the card.
        ask: String,
        /// What the card shows — usually the candidates to pick from.
        #[serde(default)]
        show: Value,
        #[serde(default)]
        pick: Pick,
    },
    Flow {
        flow: String,
        #[serde(default)]
        inputs: Value,
    },
    Set {
        value: Value,
        /// When `value` is a list, keep only the items this holds for
        /// (each in reach as `item`) — e.g. drop the pictures that failed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keep: Option<Cond>,
    },
    /// L4. The slot is here so a flow can name it; running one is refused.
    Agent {
        #[serde(flatten)]
        spec: Map<String, Value>,
    },
    Seq {
        steps: Vec<Node>,
    },
    Parallel {
        branches: Vec<Vec<Node>>,
    },
    Each {
        /// A list (`${inputs.materials}`), or an object of lists for their
        /// product (`{ "cond": "${inputs.conditions}", "model": "${inputs.models}" }`
        /// binds `cond` and `model` for every pair).
        over: Value,
        /// The name an item of a plain list is bound to. Default `item`.
        #[serde(rename = "as", default, skip_serializing_if = "Option::is_none")]
        as_name: Option<String>,
        steps: Vec<Node>,
        /// Items at once. Default 4.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<usize>,
    },
    If {
        when: Cond,
        #[serde(default)]
        then: Vec<Node>,
        #[serde(rename = "else", default)]
        otherwise: Vec<Node>,
    },
    Repeat {
        max: u32,
        /// Checked after every round, with that round's outputs in reach.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until: Option<Cond>,
        steps: Vec<Node>,
    },
}

impl NodeKind {
    pub fn name(&self) -> &'static str {
        match self {
            NodeKind::Op { .. } => "op",
            NodeKind::Model { .. } => "model",
            NodeKind::Human { .. } => "human",
            NodeKind::Flow { .. } => "flow",
            NodeKind::Set { .. } => "set",
            NodeKind::Agent { .. } => "agent",
            NodeKind::Seq { .. } => "seq",
            NodeKind::Parallel { .. } => "parallel",
            NodeKind::Each { .. } => "each",
            NodeKind::If { .. } => "if",
            NodeKind::Repeat { .. } => "repeat",
        }
    }
}

/// What a `human` card asks for.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Pick {
    /// One of the shown items (its index) plus an optional line.
    #[default]
    One,
    /// Any number of them.
    Many,
    /// A line of text.
    Text,
    /// Go on or stop.
    Ok,
}

/// A condition. Both sides go through `${…}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Cond {
    All {
        all: Vec<Cond>,
    },
    Any {
        any: Vec<Cond>,
    },
    Not {
        not: Box<Cond>,
    },
    Test {
        left: Value,
        op: CondOp,
        #[serde(default)]
        right: Value,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CondOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    /// `left` is not null.
    Exists,
    /// `left` is true, a non-zero number, a non-empty string, list or object.
    Truthy,
    Falsy,
    /// `left` is one of the list `right`, or a substring of the string `right`.
    In,
}

/// Problems that keep a flow from running, each a readable line.
pub fn validate(doc: &FlowDoc) -> Vec<String> {
    let mut issues = Vec::new();
    if doc.schema != 1 {
        issues.push(format!(
            "schema {} — this Studio reads schema 1",
            doc.schema
        ));
    }
    if !valid_id(&doc.id) {
        issues.push(format!("id `{}` — use a-z, 0-9, - and _", doc.id));
    }
    if doc.want.text.trim().is_empty() {
        issues.push("want.text is empty — say what is wanted in one line".into());
    }
    if doc.steps.is_empty() {
        issues.push("no steps".into());
    }
    let mut seen = HashSet::new();
    walk(&doc.steps, &mut |node| {
        if !valid_id(&node.id) {
            issues.push(format!("node id `{}` — use a-z, 0-9, - and _", node.id));
        } else if ["inputs", "want", "run", "item", "index"].contains(&node.id.as_str()) {
            issues.push(format!("node id `{}` is a reserved name", node.id));
        }
        if !seen.insert(node.id.clone()) {
            issues.push(format!("node id `{}` is used twice", node.id));
        }
        match &node.kind {
            NodeKind::Agent { .. } => issues.push(format!(
                "{}: agent nodes come with L4 (layers-l4-agent) — use op or model for now",
                node.id
            )),
            NodeKind::Repeat { max, .. } if *max == 0 || *max > MAX_REPEAT => {
                issues.push(format!("{}: repeat max must be 1..={MAX_REPEAT}", node.id))
            }
            NodeKind::Each { limit: Some(l), .. } if *l == 0 || *l > MAX_EACH_LIMIT => issues.push(
                format!("{}: each limit must be 1..={MAX_EACH_LIMIT}", node.id),
            ),
            NodeKind::Op { op, .. } if op.trim().is_empty() => {
                issues.push(format!("{}: op is empty", node.id))
            }
            NodeKind::Parallel { branches } if branches.is_empty() => {
                issues.push(format!("{}: parallel has no branches", node.id))
            }
            _ => {}
        }
    });
    issues
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Every node, depth first.
pub fn walk<'a>(nodes: &'a [Node], f: &mut dyn FnMut(&'a Node)) {
    for node in nodes {
        f(node);
        match &node.kind {
            NodeKind::Seq { steps }
            | NodeKind::Each { steps, .. }
            | NodeKind::Repeat { steps, .. } => walk(steps, f),
            NodeKind::Parallel { branches } => {
                for b in branches {
                    walk(b, f);
                }
            }
            NodeKind::If {
                then, otherwise, ..
            } => {
                walk(then, f);
                walk(otherwise, f);
            }
            _ => {}
        }
    }
}

// ─── References: ${…} ───

/// The names in reach of a node: `inputs`, `want`, `run`, the outputs of the
/// nodes before it (by id) and the bindings of the `each` / `repeat` it is in.
/// Inner frames shadow outer ones.
#[derive(Debug, Clone, Default)]
pub struct Scope {
    frames: Vec<Map<String, Value>>,
}

impl Scope {
    pub fn new(base: Map<String, Value>) -> Self {
        Self { frames: vec![base] }
    }

    fn child(&self) -> Self {
        let mut frames = self.frames.clone();
        frames.push(Map::new());
        Self { frames }
    }

    fn set(&mut self, name: &str, value: Value) {
        if let Some(top) = self.frames.last_mut() {
            top.insert(name.to_string(), value);
        }
    }

    fn top(&self) -> Map<String, Value> {
        self.frames.last().cloned().unwrap_or_default()
    }

    fn get(&self, name: &str) -> Option<&Value> {
        self.frames.iter().rev().find_map(|f| f.get(name))
    }
}

/// Resolve every `${…}` in `value`.
pub fn resolve(value: &Value, scope: &Scope) -> Result<Value, String> {
    match value {
        Value::String(s) => resolve_str(s, scope),
        Value::Array(items) => items
            .iter()
            .map(|v| resolve(v, scope))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k.clone(), resolve(v, scope)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn resolve_str(s: &str, scope: &Scope) -> Result<Value, String> {
    let trimmed = s.trim();
    if trimmed.starts_with("${")
        && trimmed.ends_with('}')
        && !trimmed[2..].contains("${")
        && trimmed.matches('}').count() == 1
    {
        return lookup(&trimmed[2..trimmed.len() - 1], scope);
    }
    if !s.contains("${") {
        return Ok(Value::String(s.to_string()));
    }
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            return Err(format!("`{s}`: ${{ without }}"));
        };
        match lookup(&after[..end], scope)? {
            Value::String(v) => out.push_str(&v),
            Value::Null => {}
            v => out.push_str(&v.to_string()),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(Value::String(out))
}

/// `a.b[0].c`, `a.*.b` — a path into the scope.
pub fn lookup(path: &str, scope: &Scope) -> Result<Value, String> {
    let segs = split_path(path.trim())?;
    let Some((first, rest)) = segs.split_first() else {
        return Err("empty ${}".into());
    };
    let Seg::Key(name) = first else {
        return Err(format!("${{{path}}}: starts with an index"));
    };
    let root = scope
        .get(name)
        .ok_or_else(|| format!("${{{path}}}: nothing named `{name}` is in reach here"))?;
    follow(root, rest).map_err(|e| format!("${{{path}}}: {e}"))
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Key(String),
    Index(usize),
    All,
}

fn split_path(path: &str) -> Result<Vec<Seg>, String> {
    let mut segs = Vec::new();
    for part in path.split('.') {
        let (key, mut idx) = match part.find('[') {
            Some(i) => (&part[..i], &part[i..]),
            None => (part, ""),
        };
        if key == "*" {
            segs.push(Seg::All);
        } else if !key.is_empty() {
            segs.push(Seg::Key(key.to_string()));
        } else if idx.is_empty() {
            return Err(format!("`{path}`: empty segment"));
        }
        while let Some(rest) = idx.strip_prefix('[') {
            let end = rest
                .find(']')
                .ok_or_else(|| format!("`{path}`: [ without ]"))?;
            let n = rest[..end]
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("`{path}`: [{}] is not an index", &rest[..end]))?;
            segs.push(Seg::Index(n));
            idx = &rest[end + 1..];
        }
        if !idx.is_empty() {
            return Err(format!("`{path}`: stray `{idx}`"));
        }
    }
    Ok(segs)
}

fn follow(value: &Value, segs: &[Seg]) -> Result<Value, String> {
    let Some((seg, rest)) = segs.split_first() else {
        return Ok(value.clone());
    };
    match seg {
        Seg::Key(k) => match value {
            Value::Object(m) => match m.get(k) {
                Some(v) => follow(v, rest),
                None => Ok(Value::Null),
            },
            Value::Null => Ok(Value::Null),
            Value::Array(_) => Err(format!("`{k}` asked of a list — use [n] or *")),
            _ => Err(format!("`{k}` asked of a {}", type_name(value))),
        },
        Seg::Index(i) => match value {
            Value::Array(a) => a.get(*i).map_or(Ok(Value::Null), |v| follow(v, rest)),
            Value::Null => Ok(Value::Null),
            _ => Err(format!("[{i}] asked of a {}", type_name(value))),
        },
        Seg::All => match value {
            Value::Array(a) => a
                .iter()
                .map(|v| follow(v, rest))
                .collect::<Result<_, _>>()
                .map(Value::Array),
            Value::Object(m) => m
                .values()
                .map(|v| follow(v, rest))
                .collect::<Result<_, _>>()
                .map(Value::Array),
            Value::Null => Ok(Value::Array(vec![])),
            _ => Err(format!("* asked of a {}", type_name(value))),
        },
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "true/false",
        Value::Number(_) => "number",
        Value::String(_) => "text",
        Value::Array(_) => "list",
        Value::Object(_) => "object",
    }
}

pub fn eval_cond(cond: &Cond, scope: &Scope) -> Result<bool, String> {
    match cond {
        Cond::All { all } => {
            for c in all {
                if !eval_cond(c, scope)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Cond::Any { any } => {
            for c in any {
                if eval_cond(c, scope)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Cond::Not { not } => Ok(!eval_cond(not, scope)?),
        Cond::Test { left, op, right } => {
            let l = resolve(left, scope)?;
            let r = resolve(right, scope)?;
            Ok(match op {
                CondOp::Eq => loose_eq(&l, &r),
                CondOp::Ne => !loose_eq(&l, &r),
                CondOp::Gt | CondOp::Gte | CondOp::Lt | CondOp::Lte => {
                    let (Some(a), Some(b)) = (as_num(&l), as_num(&r)) else {
                        return Err(format!("cannot compare {l} with {r} as numbers"));
                    };
                    match op {
                        CondOp::Gt => a > b,
                        CondOp::Gte => a >= b,
                        CondOp::Lt => a < b,
                        _ => a <= b,
                    }
                }
                CondOp::Exists => !l.is_null(),
                CondOp::Truthy => truthy(&l),
                CondOp::Falsy => !truthy(&l),
                CondOp::In => match &r {
                    Value::Array(a) => a.iter().any(|v| loose_eq(&l, v)),
                    Value::String(s) => l.as_str().is_some_and(|x| s.contains(x)),
                    _ => false,
                },
            })
        }
    }
}

fn as_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    match (as_num(a), as_num(b)) {
        (Some(x), Some(y)) if a.is_number() || b.is_number() => x == y,
        _ => a == b,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}

// ─── The record ───

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Running,
    /// Stopped at a `human` card.
    Waiting,
    Done,
    Failed,
    /// The node was not reached this time (the other branch of an `if`).
    Skipped,
}

/// One node, once. `key` tells the copies apart: `gen` once, `fan[2].gen`
/// for the third item of `fan`, `loop#1.fix` for the second round of `loop`,
/// `sub>pick` inside the `flow` node `sub`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeRecord {
    pub key: String,
    pub node: String,
    pub kind: String,
    pub status: Status,
    /// The node's arguments with every `${…}` resolved.
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub output: Value,
    /// Who answered: `op:<id>`, `claude/sonnet`, `codex`, `human`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The run this output was taken from instead of calling again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reused_from: Option<String>,
    /// The leaf's definition, to tell a changed node from a changed input.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub def: Value,
    /// Taken from an earlier record in this execution rather than run.
    #[serde(skip)]
    reused: bool,
}

/// A `human` node's question, waiting for an answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Card {
    pub key: String,
    pub ask: String,
    pub show: Value,
    pub pick: Pick,
    pub since: String,
}

/// `runs/<flow>/<run>/run.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunRecord {
    pub schema: u32,
    pub id: String,
    pub flow: String,
    pub status: Status,
    pub want: Want,
    pub inputs: Map<String, Value>,
    /// The flow as it was when the run started (and the flows it called).
    pub flow_doc: FlowDoc,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sub_flows: BTreeMap<String, FlowDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_run: Option<String>,
    /// A line on what this run tries differently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub ms: u64,
    #[serde(default)]
    pub cost_usd: f64,
    pub nodes: Vec<NodeRecord>,
    #[serde(default)]
    pub waiting: Vec<Card>,
    /// Answers to cards, by node key.
    #[serde(default)]
    pub answers: BTreeMap<String, Value>,
    #[serde(default)]
    pub output: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl RunRecord {
    fn record(&mut self, rec: NodeRecord) {
        match self.nodes.iter_mut().find(|n| n.key == rec.key) {
            Some(slot) => *slot = rec,
            None => self.nodes.push(rec),
        }
    }

    fn total_cost(&self) -> f64 {
        self.nodes
            .iter()
            .filter(|n| n.reused_from.is_none())
            .filter_map(|n| n.cost_usd)
            .sum()
    }
}

// ─── Parts ───

/// How the executor reaches the Studio's parts.
#[async_trait]
pub trait Parts: Send + Sync {
    /// Run one part by its registry id. The outcome follows the studio rule:
    /// `{ ok: false, note }` is a failure.
    async fn call(&self, op: &str, args: Value) -> Value;
}

// ─── Files ───

pub fn flow_path(root: &Path, id: &str) -> PathBuf {
    root.join(FLOWS_DIR).join(format!("{id}{FLOW_SUFFIX}"))
}

pub fn run_dir(root: &Path, flow: &str, run: &str) -> PathBuf {
    root.join(RUNS_DIR).join(flow).join(run)
}

pub fn read_flow(root: &Path, id: &str) -> Result<FlowDoc, String> {
    if !valid_id(id) {
        return Err(format!("flow id `{id}` — use a-z, 0-9, - and _"));
    }
    let path = flow_path(root, id);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("{FLOWS_DIR}/{id}{FLOW_SUFFIX}: {e}"))?;
    let doc: FlowDoc =
        serde_json::from_str(&text).map_err(|e| format!("{FLOWS_DIR}/{id}{FLOW_SUFFIX}: {e}"))?;
    if doc.id != id {
        return Err(format!(
            "{FLOWS_DIR}/{id}{FLOW_SUFFIX} says its id is `{}`",
            doc.id
        ));
    }
    Ok(doc)
}

/// Every flow in the project, with its problems.
pub fn list_flows(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root.join(FLOWS_DIR)) else {
        return out;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(FLOW_SUFFIX)
                .map(str::to_string)
        })
        .collect();
    names.sort();
    for id in names {
        match read_flow(root, &id) {
            Ok(doc) => {
                let issues = validate(&doc);
                let mut count = 0;
                walk(&doc.steps, &mut |_| count += 1);
                out.push(json!({
                    "id": doc.id, "title": doc.title, "want": doc.want.text,
                    "inputs": doc.inputs.keys().collect::<Vec<_>>(),
                    "nodes": count, "issues": issues,
                }));
            }
            Err(e) => out.push(json!({ "id": id, "issues": [e] })),
        }
    }
    out
}

pub fn read_run(root: &Path, flow: &str, run: &str) -> Result<RunRecord, String> {
    if !valid_id(flow) || !valid_run_id(run) {
        return Err(format!("no run {flow}/{run}"));
    }
    let path = run_dir(root, flow, run).join(RUN_FILE);
    let text = std::fs::read_to_string(&path).map_err(|_| format!("no run {flow}/{run}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{RUNS_DIR}/{flow}/{run}/{RUN_FILE}: {e}"))
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The runs of one flow (or of all), newest first, as summaries.
pub fn list_runs(root: &Path, flow: Option<&str>) -> Vec<Value> {
    let mut out = Vec::new();
    let flows: Vec<String> = match flow {
        Some(f) => vec![f.to_string()],
        None => std::fs::read_dir(root.join(RUNS_DIR))
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().to_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    };
    for f in flows {
        let Ok(entries) = std::fs::read_dir(root.join(RUNS_DIR).join(&f)) else {
            continue;
        };
        for e in entries.filter_map(|e| e.ok()) {
            let Some(run) = e.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if let Ok(r) = read_run(root, &f, &run) {
                out.push(summary(&r));
            }
        }
    }
    out.sort_by(|a, b| b["started_at"].as_str().cmp(&a["started_at"].as_str()));
    out
}

pub fn summary(r: &RunRecord) -> Value {
    json!({
        "flow": r.flow, "run": r.id, "status": r.status, "label": r.label,
        "want": r.want.text, "from_run": r.from_run,
        "started_at": r.started_at, "ended_at": r.ended_at, "ms": r.ms,
        "cost_usd": r.cost_usd, "nodes": r.nodes.len(),
        "waiting": r.waiting.iter().map(|c| json!({ "key": c.key, "ask": c.ask })).collect::<Vec<_>>(),
        "note": r.note,
    })
}

/// Every card waiting for an answer in the project.
pub fn waiting_cards(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for s in list_runs(root, None) {
        if s["status"] != json!(Status::Waiting) {
            continue;
        }
        let (Some(flow), Some(run)) = (s["flow"].as_str(), s["run"].as_str()) else {
            continue;
        };
        if let Ok(r) = read_run(root, flow, run) {
            for c in r.waiting {
                out.push(json!({ "flow": flow, "run": run, "want": r.want.text, "card": c }));
            }
        }
    }
    out
}

fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text + "\n")?;
    std::fs::rename(&tmp, path)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn new_run_id() -> String {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!("{stamp}-{}", &tail[..4])
}

// ─── Running ───

/// What starts a run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RunRequest {
    pub flow: String,
    /// Overrides of the flow's `inputs`.
    #[serde(default)]
    pub inputs: Map<String, Value>,
    /// An earlier run of the same flow: every leaf whose definition and input
    /// are unchanged takes that run's output instead of calling again, and
    /// its answered cards stay answered unless their question changed.
    #[serde(default)]
    pub from_run: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Runs being executed in this process, so a resume does not run twice.
fn active() -> &'static Mutex<HashSet<String>> {
    static ACTIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

type LiveCard = (Card, tokio::sync::oneshot::Sender<Value>);

/// Cards a running node is waiting on in this process, by `flow/run/key`.
fn live() -> &'static Mutex<HashMap<String, LiveCard>> {
    static LIVE: OnceLock<Mutex<HashMap<String, LiveCard>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Create the run's record (status `running`) and return it; [`execute`]
/// then carries it out. Split so a door can answer with the run id at once
/// and execute in the background.
pub fn prepare(root: &Path, req: &RunRequest) -> Result<RunRecord, String> {
    let doc = read_flow(root, &req.flow)?;
    let issues = validate(&doc);
    if !issues.is_empty() {
        return Err(format!("{} can't run: {}", req.flow, issues.join(" · ")));
    }
    let base = match &req.from_run {
        Some(id) => Some(read_run(root, &req.flow, id)?),
        None => None,
    };
    let mut inputs = doc.inputs.clone();
    for (k, v) in &req.inputs {
        inputs.insert(k.clone(), v.clone());
    }
    let mut run = RunRecord {
        schema: 1,
        id: new_run_id(),
        flow: doc.id.clone(),
        status: Status::Running,
        want: doc.want.clone(),
        inputs,
        flow_doc: doc,
        sub_flows: BTreeMap::new(),
        from_run: req.from_run.clone(),
        label: req.label.clone(),
        started_at: now(),
        ended_at: None,
        ms: 0,
        cost_usd: 0.0,
        nodes: vec![],
        waiting: vec![],
        answers: BTreeMap::new(),
        output: Value::Null,
        note: None,
    };
    if let Some(base) = base {
        // Earlier outputs become candidates for reuse; the executor keeps
        // only those whose definition and input still match.
        run.nodes = base
            .nodes
            .into_iter()
            .filter(|n| n.status == Status::Done && !n.def.is_null())
            .map(|mut n| {
                n.reused_from.get_or_insert(base.id.clone());
                n
            })
            .collect();
    }
    write_json(&run_dir(root, &run.flow, &run.id).join(RUN_FILE), &run)
        .map_err(|e| format!("can't write the run record: {e}"))?;
    Ok(run)
}

/// Start a run and wait for it to finish or stop at a card.
pub async fn run_flow(
    root: &Path,
    parts: Arc<dyn Parts>,
    req: &RunRequest,
) -> Result<RunRecord, String> {
    let run = prepare(root, req)?;
    Ok(execute(root, parts, run).await)
}

/// Answer a waiting card and resume the run (until it finishes or stops at
/// the next card).
pub async fn answer(
    root: &Path,
    parts: Arc<dyn Parts>,
    flow: &str,
    run: &str,
    key: &str,
    value: Value,
) -> Result<RunRecord, String> {
    let slot = format!("{flow}/{run}/{key}");
    let waiter = live().lock().unwrap().remove(&slot);
    if let Some((card, tx)) = waiter {
        let value = check_answer(&card, value)?;
        let _ = tx.send(value);
        return read_run(root, flow, run);
    }
    let mut rec = prepare_answer(root, flow, run, key, value)?;
    rec.status = Status::Running;
    Ok(execute(root, parts, rec).await)
}

/// Check and store an answer, without resuming.
pub fn prepare_answer(
    root: &Path,
    flow: &str,
    run: &str,
    key: &str,
    value: Value,
) -> Result<RunRecord, String> {
    let mut rec = read_run(root, flow, run)?;
    let Some(card) = rec.waiting.iter().find(|c| c.key == key) else {
        let open: Vec<&str> = rec.waiting.iter().map(|c| c.key.as_str()).collect();
        return Err(if open.is_empty() {
            format!("{flow}/{run} is not waiting for an answer")
        } else {
            format!(
                "{flow}/{run} has no card `{key}` — waiting: {}",
                open.join(", ")
            )
        });
    };
    let value = check_answer(card, value)?;
    rec.answers.insert(key.to_string(), value);
    write_json(&run_dir(root, flow, run).join(RUN_FILE), &rec)
        .map_err(|e| format!("can't write the run record: {e}"))?;
    Ok(rec)
}

/// Shape an answer: `one` → `{ index, item, note? }`, `many` →
/// `{ indexes, items, note? }`, `text` → `{ text }`, `ok` → `{ ok, note? }`.
/// Bare values are accepted (`2`, `[0, 3]`, `"text"`, `true`).
fn check_answer(card: &Card, value: Value) -> Result<Value, String> {
    let items = card.show.as_array().cloned().unwrap_or_default();
    let note = value.get("note").cloned().unwrap_or(Value::Null);
    let item_at = |i: u64| -> Result<Value, String> {
        items
            .get(i as usize)
            .cloned()
            .ok_or_else(|| format!("there are {} items — {i} is out of range", items.len()))
    };
    let mut out = match card.pick {
        Pick::One => {
            let i = value
                .as_u64()
                .or_else(|| value.get("index").and_then(Value::as_u64))
                .ok_or("answer with the index of one item (0-based)")?;
            json!({ "index": i, "item": item_at(i)? })
        }
        Pick::Many => {
            let list = value
                .as_array()
                .or_else(|| value.get("indexes").and_then(Value::as_array))
                .ok_or("answer with a list of item indexes (0-based)")?;
            let idx: Vec<u64> = list.iter().filter_map(Value::as_u64).collect();
            let picked = idx
                .iter()
                .map(|i| item_at(*i))
                .collect::<Result<Vec<_>, _>>()?;
            json!({ "indexes": idx, "items": picked })
        }
        Pick::Text => {
            let t = value
                .as_str()
                .or_else(|| value.get("text").and_then(Value::as_str))
                .ok_or("answer with a line of text")?;
            json!({ "text": t })
        }
        Pick::Ok => {
            let ok = value
                .as_bool()
                .or_else(|| value.get("ok").and_then(Value::as_bool))
                .ok_or("answer with true (go on) or false (stop)")?;
            json!({ "ok": ok })
        }
    };
    if !note.is_null() {
        out["note"] = note;
    }
    Ok(out)
}

/// Carry out a prepared run. Never panics on a bad flow — the outcome is in
/// the returned record (and on disk).
pub async fn execute(root: &Path, parts: Arc<dyn Parts>, run: RunRecord) -> RunRecord {
    let slot = format!("{}/{}", run.flow, run.id);
    if !active().lock().unwrap().insert(slot.clone()) {
        let mut r = run;
        r.note = Some("this run is already being carried out".into());
        return r;
    }
    let started = Instant::now();
    let doc = run.flow_doc.clone();
    let mut base = Map::new();
    base.insert("inputs".into(), Value::Object(run.inputs.clone()));
    base.insert(
        "want".into(),
        serde_json::to_value(&run.want).unwrap_or_default(),
    );
    base.insert(
        "run".into(),
        json!({ "id": run.id, "flow": run.flow, "dir": format!("{RUNS_DIR}/{}/{}", run.flow, run.id) }),
    );
    let prior: HashMap<String, NodeRecord> = run
        .nodes
        .iter()
        .map(|n| (n.key.clone(), n.clone()))
        .collect();
    let answers = run.answers.clone();
    let mut fresh = run.clone();
    fresh.nodes.clear();
    fresh.waiting.clear();
    fresh.status = Status::Running;
    fresh.note = None;
    let ex = Arc::new(Exec {
        root: root.to_path_buf(),
        parts,
        prior,
        answers,
        state: Mutex::new(fresh),
    });
    let mut scope = Scope::new(base);
    let result = ex
        .clone()
        .run_steps(doc.steps.clone(), String::new(), &mut scope, 0)
        .await;
    let output = match (&result, &doc.output) {
        (Ok(_), Some(expr)) => {
            resolve(expr, &scope).unwrap_or_else(|e| json!({ "ok": false, "note": e }))
        }
        (Ok(v), None) => v.clone(),
        _ => Value::Null,
    };
    let elapsed = started.elapsed().as_millis() as u64;
    let rec = {
        let mut st = ex.state.lock().unwrap();
        match result {
            Ok(_) => {
                st.status = Status::Done;
                st.output = output;
                st.ended_at = Some(now());
            }
            Err(Stop::Waiting) => st.status = Status::Waiting,
            Err(Stop::Failed(note)) => {
                st.status = Status::Failed;
                st.note = Some(note);
                st.ended_at = Some(now());
            }
        }
        st.ms += elapsed;
        st.cost_usd = st.total_cost();
        st.clone()
    };
    let _ = write_json(&run_dir(root, &rec.flow, &rec.id).join(RUN_FILE), &rec);
    active().lock().unwrap().remove(&slot);
    rec
}

#[derive(Debug)]
enum Stop {
    Waiting,
    Failed(String),
}

struct Exec {
    root: PathBuf,
    parts: Arc<dyn Parts>,
    prior: HashMap<String, NodeRecord>,
    answers: BTreeMap<String, Value>,
    state: Mutex<RunRecord>,
}

type Step = Result<Value, Stop>;

impl Exec {
    fn save(&self, rec: NodeRecord) {
        let snapshot = {
            let mut st = self.state.lock().unwrap();
            st.record(rec);
            st.cost_usd = st.total_cost();
            st.clone()
        };
        let _ = write_json(
            &run_dir(&self.root, &snapshot.flow, &snapshot.id).join(RUN_FILE),
            &snapshot,
        );
    }

    fn wait_on(&self, card: Card) {
        let mut st = self.state.lock().unwrap();
        st.waiting.retain(|c| c.key != card.key);
        st.waiting.push(card);
    }

    /// Steps in order in one frame; each output is put in reach under its
    /// node id. The output is the last step's.
    fn run_steps(
        self: Arc<Self>,
        steps: Vec<Node>,
        prefix: String,
        scope: &mut Scope,
        depth: usize,
    ) -> BoxFuture<'_, Step> {
        async move {
            let mut last = Value::Null;
            for node in steps {
                let key = format!("{prefix}{}", node.id);
                let out = self
                    .clone()
                    .run_node(node.clone(), key, scope.clone(), depth)
                    .await?;
                scope.set(&node.id, out.clone());
                last = out;
            }
            Ok(last)
        }
        .boxed()
    }

    fn run_node(
        self: Arc<Self>,
        node: Node,
        key: String,
        scope: Scope,
        depth: usize,
    ) -> BoxFuture<'static, Step> {
        async move {
            let started_at = now();
            let t = Instant::now();
            let mut rec = NodeRecord {
                key: key.clone(),
                node: node.id.clone(),
                kind: node.kind.name().into(),
                status: Status::Running,
                input: Value::Null,
                output: Value::Null,
                who: None,
                started_at,
                ms: 0,
                cost_usd: None,
                log: vec![],
                note: None,
                reused_from: None,
                def: Value::Null,
                reused: false,
            };
            let result = self
                .clone()
                .node_body(&node, &key, scope, depth, &mut rec)
                .await;
            // A reused leaf keeps the start and time it was recorded with.
            if !rec.reused {
                rec.ms = t.elapsed().as_millis() as u64;
            }
            let result = match result {
                Ok(v) => {
                    rec.status = Status::Done;
                    rec.output = v.clone();
                    Ok(v)
                }
                Err(Stop::Waiting) => {
                    rec.status = Status::Waiting;
                    Err(Stop::Waiting)
                }
                Err(Stop::Failed(note)) => {
                    rec.status = Status::Failed;
                    rec.note = Some(note.clone());
                    if node.keep_going {
                        let v = json!({ "ok": false, "note": note });
                        rec.output = v.clone();
                        Ok(v)
                    } else {
                        Err(Stop::Failed(format!("{key}: {note}")))
                    }
                }
            };
            self.save(rec);
            result
        }
        .boxed()
    }

    async fn node_body(
        self: Arc<Self>,
        node: &Node,
        key: &str,
        scope: Scope,
        depth: usize,
        rec: &mut NodeRecord,
    ) -> Step {
        let fail = |e: String| Stop::Failed(e);
        match &node.kind {
            NodeKind::Op { op, args } => {
                let input = resolve(args, &scope).map_err(fail)?;
                self.call_part(node, key, op, input, rec, format!("op:{op}"))
                    .await
            }
            NodeKind::Model { op, args } => {
                let input = resolve(args, &scope).map_err(fail)?;
                let op = op.as_deref().unwrap_or(MODEL_OP);
                let who = who_for_model(op, &input);
                self.call_part(node, key, op, input, rec, who).await
            }
            NodeKind::Set { value, keep } => {
                let mut v = resolve(value, &scope).map_err(fail)?;
                if let (Some(cond), Value::Array(items)) = (keep, &v) {
                    let mut kept = Vec::new();
                    for item in items {
                        let mut inner = scope.child();
                        inner.set("item", item.clone());
                        if eval_cond(cond, &inner).map_err(fail)? {
                            kept.push(item.clone());
                        }
                    }
                    v = Value::Array(kept);
                }
                rec.input = v.clone();
                Ok(v)
            }
            NodeKind::Human { ask, show, pick } => {
                let ask = match resolve_str(ask, &scope).map_err(fail)? {
                    Value::String(s) => s,
                    v => v.to_string(),
                };
                let show = resolve(show, &scope).map_err(fail)?;
                rec.input = json!({ "ask": ask, "show": show, "pick": pick });
                rec.who = Some("human".into());
                rec.def = json!({ "ask": ask, "show": show, "pick": pick });
                if let Some(a) = self.answers.get(key) {
                    return Ok(a.clone());
                }
                // An answer from an earlier run (or an earlier pass of this
                // one) counts only while the card asks the same thing about
                // the same items.
                if let Some(p) = self
                    .prior
                    .get(key)
                    .filter(|p| p.status == Status::Done && p.def == rec.def)
                {
                    rec.reused_from = p.reused_from.clone();
                    return Ok(p.output.clone());
                }
                self.wait_on(Card {
                    key: key.to_string(),
                    ask,
                    show,
                    pick: *pick,
                    since: now(),
                });
                Err(Stop::Waiting)
            }
            NodeKind::Agent { .. } => {
                Err(fail("agent nodes come with L4 (layers-l4-agent)".into()))
            }
            NodeKind::Flow { flow, inputs } => {
                if depth >= MAX_FLOW_DEPTH {
                    return Err(fail(format!("flows nest deeper than {MAX_FLOW_DEPTH}")));
                }
                let doc = read_flow(&self.root, flow).map_err(fail)?;
                let issues = validate(&doc);
                if !issues.is_empty() {
                    return Err(fail(format!("{flow}: {}", issues.join(" · "))));
                }
                let given = resolve(inputs, &scope).map_err(fail)?;
                let mut merged = doc.inputs.clone();
                if let Value::Object(m) = &given {
                    for (k, v) in m {
                        merged.insert(k.clone(), v.clone());
                    }
                }
                rec.input = Value::Object(merged.clone());
                self.state
                    .lock()
                    .unwrap()
                    .sub_flows
                    .insert(doc.id.clone(), doc.clone());
                let mut base = Map::new();
                base.insert("inputs".into(), Value::Object(merged));
                base.insert(
                    "want".into(),
                    serde_json::to_value(&doc.want).unwrap_or_default(),
                );
                if let Some(run) = scope.get("run") {
                    base.insert("run".into(), run.clone());
                }
                let mut inner = Scope::new(base);
                let last = self
                    .clone()
                    .run_steps(doc.steps.clone(), format!("{key}>"), &mut inner, depth + 1)
                    .await?;
                match &doc.output {
                    Some(expr) => resolve(expr, &inner).map_err(fail),
                    None => Ok(last),
                }
            }
            NodeKind::Seq { steps } => {
                let mut inner = scope.child();
                let last = self
                    .clone()
                    .run_steps(steps.clone(), format!("{key}."), &mut inner, depth)
                    .await?;
                let _ = last;
                Ok(Value::Object(inner.top()))
            }
            NodeKind::Parallel { branches } => {
                let futs = branches.iter().enumerate().map(|(b, steps)| {
                    let ex = self.clone();
                    let mut inner = scope.child();
                    let steps = steps.clone();
                    let prefix = format!("{key}/{b}.");
                    async move {
                        let r = ex.run_steps(steps, prefix, &mut inner, depth).await;
                        r.map(|_| Value::Object(inner.top()))
                    }
                    .boxed()
                });
                let results = futures::future::join_all(futs).await;
                gather(results)
            }
            NodeKind::Each {
                over,
                as_name,
                steps,
                limit,
            } => {
                let items = expand(over, as_name.as_deref(), &scope).map_err(fail)?;
                rec.input = json!({ "count": items.len(), "items": items });
                let limit = limit.unwrap_or(DEFAULT_EACH_LIMIT).clamp(1, MAX_EACH_LIMIT);
                let futs = items.into_iter().enumerate().map(|(i, bind)| {
                    let ex = self.clone();
                    let mut inner = scope.child();
                    for (k, v) in bind {
                        inner.set(&k, v);
                    }
                    inner.set("index", json!(i));
                    let steps = steps.clone();
                    let prefix = format!("{key}[{i}].");
                    async move {
                        let r = ex.run_steps(steps, prefix, &mut inner, depth).await;
                        r.map(|_| Value::Object(inner.top()))
                    }
                    .boxed()
                });
                let results: Vec<Step> = stream::iter(futs).buffered(limit).collect().await;
                gather(results)
            }
            NodeKind::If {
                when,
                then,
                otherwise,
            } => {
                let yes = eval_cond(when, &scope).map_err(fail)?;
                rec.input = json!({ "took": if yes { "then" } else { "else" } });
                let branch = if yes { then } else { otherwise };
                let mut inner = scope.child();
                let last = self
                    .clone()
                    .run_steps(branch.clone(), format!("{key}."), &mut inner, depth)
                    .await?;
                Ok(last)
            }
            NodeKind::Repeat { max, until, steps } => {
                let mut rounds = Vec::new();
                for n in 0..*max {
                    let mut inner = scope.child();
                    inner.set("round", json!(n));
                    if let Some(prev) = rounds.last() {
                        inner.set("prev", Value::clone(prev));
                    }
                    self.clone()
                        .run_steps(steps.clone(), format!("{key}#{n}."), &mut inner, depth)
                        .await?;
                    let done = match until {
                        Some(c) => eval_cond(c, &inner).map_err(fail)?,
                        None => false,
                    };
                    rounds.push(Value::Object(inner.top()));
                    if done {
                        break;
                    }
                }
                rec.input = json!({ "rounds": rounds.len(), "max": max });
                Ok(
                    json!({ "rounds": rounds.len(), "last": rounds.last().cloned().unwrap_or(Value::Null), "all": rounds }),
                )
            }
        }
    }

    /// Show a card and wait for its answer without stopping the run — for a
    /// node that cannot be replayed, such as an agent session asking for a
    /// permission. The card is in the run record like any other; [`answer`]
    /// hands the answer here while this process is alive.
    #[allow(dead_code)] // the agent node (L4) is its first caller
    pub(crate) async fn ask_live(&self, card: Card) -> Result<Value, String> {
        let (flow, run) = {
            let st = self.state.lock().unwrap();
            (st.flow.clone(), st.id.clone())
        };
        let slot = format!("{flow}/{run}/{}", card.key);
        let (tx, rx) = tokio::sync::oneshot::channel();
        live()
            .lock()
            .unwrap()
            .insert(slot.clone(), (card.clone(), tx));
        let snapshot = {
            let mut st = self.state.lock().unwrap();
            st.waiting.retain(|c| c.key != card.key);
            st.waiting.push(card.clone());
            st.status = Status::Waiting;
            st.clone()
        };
        let _ = write_json(&run_dir(&self.root, &flow, &run).join(RUN_FILE), &snapshot);
        let answer = rx.await.map_err(|_| "the card was dropped".to_string());
        live().lock().unwrap().remove(&slot);
        let snapshot = {
            let mut st = self.state.lock().unwrap();
            st.waiting.retain(|c| c.key != card.key);
            if let Ok(a) = &answer {
                st.answers.insert(card.key.clone(), a.clone());
            }
            if st.waiting.is_empty() {
                st.status = Status::Running;
            }
            st.clone()
        };
        let _ = write_json(&run_dir(&self.root, &flow, &run).join(RUN_FILE), &snapshot);
        answer
    }

    async fn call_part(
        &self,
        node: &Node,
        key: &str,
        op: &str,
        input: Value,
        rec: &mut NodeRecord,
        who: String,
    ) -> Step {
        rec.input = input.clone();
        rec.who = Some(who);
        rec.def = serde_json::to_value(&node.kind).unwrap_or_default();
        if let Some(p) = self.prior.get(key) {
            if p.input == input && p.def == rec.def {
                // A failure that was let through stays one while this run
                // resumes, so a card already shown keeps its items; a new
                // run (`from_run` carries only successes) tries again.
                let kept_failure = p.status == Status::Failed && p.reused_from.is_none() && node.keep_going;
                if p.status == Status::Done || kept_failure {
                    rec.reused = true;
                    rec.reused_from = p.reused_from.clone();
                    rec.started_at = p.started_at.clone();
                    rec.ms = p.ms;
                    rec.cost_usd = p.cost_usd;
                    rec.log = p.log.clone();
                    rec.output = p.output.clone();
                    if kept_failure {
                        return Err(Stop::Failed(p.note.clone().unwrap_or_default()));
                    }
                    return Ok(p.output.clone());
                }
            }
        }
        // Show the call while it runs — a generation takes minutes.
        self.save(rec.clone());
        let outcome = self.parts.call(op, input).await;
        rec.cost_usd = outcome
            .get("cost_usd")
            .and_then(Value::as_f64)
            .or_else(|| outcome.pointer("/usage/cost_usd").and_then(Value::as_f64));
        if let Some(log) = outcome.get("log") {
            rec.log = match log {
                Value::Array(lines) => lines
                    .iter()
                    .map(|l| l.as_str().map_or(l.to_string(), str::to_string))
                    .collect(),
                Value::String(s) => s.lines().map(str::to_string).collect(),
                _ => vec![],
            };
        }
        if outcome.get("ok") == Some(&Value::Bool(false)) {
            let note = outcome
                .get("note")
                .and_then(Value::as_str)
                .unwrap_or("the part failed without a note")
                .to_string();
            rec.output = outcome;
            return Err(Stop::Failed(note));
        }
        Ok(outcome)
    }
}

fn who_for_model(op: &str, input: &Value) -> String {
    let agent = input.get("agent").and_then(Value::as_str);
    let model = input.get("model").and_then(Value::as_str);
    match (agent, model) {
        (Some(a), Some(m)) => format!("{a}/{m}"),
        (Some(a), None) => a.to_string(),
        (None, Some(m)) => format!("{op}:{m}"),
        (None, None) => format!("op:{op}"),
    }
}

/// Branch results → one list. Any failure fails the whole (the first note);
/// otherwise any card leaves the whole waiting — after every branch has gone
/// as far as it can, so one card does not hold back the others' work.
fn gather(results: Vec<Step>) -> Step {
    let mut waiting = false;
    let mut out = Vec::with_capacity(results.len());
    for r in results {
        match r {
            Ok(v) => out.push(v),
            Err(Stop::Failed(n)) => return Err(Stop::Failed(n)),
            Err(Stop::Waiting) => waiting = true,
        }
    }
    if waiting {
        Err(Stop::Waiting)
    } else {
        Ok(Value::Array(out))
    }
}

/// An `each`'s items as bindings: a list binds `as` (default `item`) per
/// element; an object of lists binds every key per combination.
fn expand(
    over: &Value,
    as_name: Option<&str>,
    scope: &Scope,
) -> Result<Vec<Vec<(String, Value)>>, String> {
    let name = as_name.unwrap_or("item").to_string();
    match over {
        Value::Object(axes) => {
            let mut combos: Vec<Vec<(String, Value)>> = vec![vec![]];
            for (axis, expr) in axes {
                let Value::Array(values) = resolve(expr, scope)? else {
                    return Err(format!("each over `{axis}`: not a list"));
                };
                combos = combos
                    .into_iter()
                    .flat_map(|c| {
                        values.iter().map(move |v| {
                            let mut c = c.clone();
                            c.push((axis.clone(), v.clone()));
                            c
                        })
                    })
                    .collect();
            }
            Ok(combos)
        }
        other => match resolve(other, scope)? {
            Value::Array(values) => Ok(values
                .into_iter()
                .map(|v| vec![(name.clone(), v)])
                .collect()),
            v => Err(format!("each over a {} — give a list", type_name(&v))),
        },
    }
}

// ─── Side by side ───

/// Two runs of the same flow, node by node: what changed in the flow, in the
/// input, and both outputs. Nodes are in the first run's order, then those
/// only the second has.
pub fn compare(a: &RunRecord, b: &RunRecord) -> Value {
    let by_key: HashMap<&str, &NodeRecord> = b.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
    let mut keys: Vec<&str> = a.nodes.iter().map(|n| n.key.as_str()).collect();
    for n in &b.nodes {
        if !keys.contains(&n.key.as_str()) {
            keys.push(&n.key);
        }
    }
    let a_by: HashMap<&str, &NodeRecord> = a.nodes.iter().map(|n| (n.key.as_str(), n)).collect();
    let defs_a = node_defs(&a.flow_doc);
    let defs_b = node_defs(&b.flow_doc);
    let mut changed_nodes: Vec<String> = defs_a
        .iter()
        .filter(|(id, d)| defs_b.get(*id) != Some(d))
        .map(|(id, _)| id.clone())
        .collect();
    changed_nodes.extend(
        defs_b
            .keys()
            .filter(|id| !defs_a.contains_key(*id))
            .cloned(),
    );
    changed_nodes.sort();
    let rows: Vec<Value> = keys
        .into_iter()
        .map(|k| {
            let (x, y) = (a_by.get(k), by_key.get(k));
            let node = x.or(y).map(|n| n.node.clone()).unwrap_or_default();
            json!({
                "key": k,
                "node": node,
                "flow_changed": changed_nodes.contains(&node),
                "input_changed": x.map(|n| &n.input) != y.map(|n| &n.input),
                "output_changed": x.map(|n| &n.output) != y.map(|n| &n.output),
                "a": x.map(|n| side(n)),
                "b": y.map(|n| side(n)),
            })
        })
        .collect();
    let mut inputs_changed: Vec<&String> = a
        .inputs
        .keys()
        .chain(b.inputs.keys())
        .filter(|k| a.inputs.get(*k) != b.inputs.get(*k))
        .collect();
    inputs_changed.sort();
    inputs_changed.dedup();
    json!({
        "flow": a.flow,
        "a": summary(a),
        "b": summary(b),
        "want_changed": a.want != b.want,
        "inputs_changed": inputs_changed,
        "nodes_changed": changed_nodes,
        "rows": rows,
    })
}

fn side(n: &NodeRecord) -> Value {
    json!({
        "status": n.status, "input": n.input, "output": n.output, "who": n.who,
        "ms": n.ms, "cost_usd": n.cost_usd, "note": n.note, "reused_from": n.reused_from,
    })
}

/// Each node's own definition (children left out), by id.
fn node_defs(doc: &FlowDoc) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    walk(&doc.steps, &mut |n| {
        let mut v = serde_json::to_value(n).unwrap_or_default();
        if let Some(m) = v.as_object_mut() {
            for child in ["steps", "branches", "then", "else"] {
                m.remove(child);
            }
        }
        out.insert(n.id.clone(), v);
    });
    out
}

// ─── Doors: the flow parts ───
//
// The registry's `flow` group ([`crate::studio_ops`]) — the same over MCP,
// HTTP and the CLI. A run started here executes in the background and calls
// the other parts through the registry ([`StudioParts`]); the caller reads it
// back with `run_get` or waits with `wait: true`.

/// The registry as [`Parts`]: a flow node calls any op by its id.
pub struct StudioParts {
    pub root: PathBuf,
}

#[async_trait]
impl Parts for StudioParts {
    async fn call(&self, op: &str, args: Value) -> Value {
        crate::studio_ops::call(self.root.clone(), op, &args).await
    }
}

fn parts_for(root: &Path) -> Arc<dyn Parts> {
    Arc::new(StudioParts { root: root.to_path_buf() })
}

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

/// What `flow_run` is asked.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RunStart {
    #[serde(flatten)]
    pub req: RunRequest,
    /// Wait until the run finishes or stops at a card (default: answer with
    /// the run id at once and run in the background).
    #[serde(default)]
    pub wait: bool,
}

/// What `run_answer` is asked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnswerRequest {
    pub flow: String,
    pub run: String,
    /// The card's key (`run_get` → `waiting[].key`).
    pub key: String,
    pub answer: Value,
    #[serde(default)]
    pub wait: bool,
}

pub async fn door_flow_list(root: &Path) -> Value {
    json!({ "ok": true, "flows": list_flows(root), "dir": FLOWS_DIR })
}

pub async fn door_flow_get(root: &Path, flow: &str) -> Value {
    match read_flow(root, flow) {
        Ok(doc) => {
            let issues = validate(&doc);
            json!({ "ok": true, "flow": doc, "issues": issues, "path": format!("{FLOWS_DIR}/{flow}{FLOW_SUFFIX}") })
        }
        Err(e) => fail(e),
    }
}

/// Write a flow document after checking it. Refuses one with problems, so a
/// flow on disk always runs.
pub async fn door_flow_put(root: &Path, flow: Value) -> Value {
    let doc: FlowDoc = match serde_json::from_value(flow) {
        Ok(d) => d,
        Err(e) => return fail(format!("not a flow document: {e}")),
    };
    let issues = validate(&doc);
    if !issues.is_empty() {
        return json!({ "ok": false, "note": format!("not written: {}", issues.join(" · ")), "issues": issues });
    }
    let path = flow_path(root, &doc.id);
    match write_json(&path, &doc) {
        Ok(()) => json!({ "ok": true, "path": rel(root, &path), "flow": doc.id }),
        Err(e) => fail(format!("writing {}: {e}", rel(root, &path))),
    }
}

pub async fn door_flow_run(root: &Path, start: RunStart) -> Value {
    let run = match prepare(root, &start.req) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let id = run.id.clone();
    if start.wait {
        let rec = execute(root, parts_for(root), run).await;
        return run_outcome(&rec);
    }
    let root = root.to_path_buf();
    let flow = run.flow.clone();
    tokio::spawn(async move {
        let parts = parts_for(&root);
        execute(&root, parts, run).await;
    });
    json!({
        "ok": true, "flow": flow, "run": id, "status": Status::Running,
        "note": "Started in the background. run_get shows its progress; a human card shows up in card_list.",
    })
}

fn run_outcome(rec: &RunRecord) -> Value {
    json!({
        "ok": rec.status != Status::Failed,
        "flow": rec.flow, "run": rec.id, "status": rec.status,
        "output": rec.output, "waiting": rec.waiting, "cost_usd": rec.cost_usd, "ms": rec.ms,
        "note": rec.note.clone().unwrap_or_default(),
    })
}

pub async fn door_run_list(root: &Path, flow: Option<String>) -> Value {
    json!({ "ok": true, "runs": list_runs(root, flow.as_deref()) })
}

pub async fn door_run_get(root: &Path, flow: &str, run: &str) -> Value {
    match read_run(root, flow, run) {
        Ok(r) => json!({ "ok": true, "run": r }),
        Err(e) => fail(e),
    }
}

pub async fn door_run_answer(root: &Path, req: AnswerRequest) -> Value {
    let slot = format!("{}/{}/{}", req.flow, req.run, req.key);
    let live = live().lock().unwrap().contains_key(&slot);
    if live || req.wait {
        return match answer(root, parts_for(root), &req.flow, &req.run, &req.key, req.answer).await {
            Ok(r) => run_outcome(&r),
            Err(e) => fail(e),
        };
    }
    let mut rec = match prepare_answer(root, &req.flow, &req.run, &req.key, req.answer) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    rec.status = Status::Running;
    let root = root.to_path_buf();
    tokio::spawn(async move {
        let parts = parts_for(&root);
        execute(&root, parts, rec).await;
    });
    json!({ "ok": true, "flow": req.flow, "run": req.run, "status": Status::Running,
            "note": "Answered; the run goes on in the background." })
}

pub async fn door_run_compare(root: &Path, flow: &str, a: &str, b: &str) -> Value {
    match (read_run(root, flow, a), read_run(root, flow, b)) {
        (Ok(x), Ok(y)) => {
            let mut out = compare(&x, &y);
            out["ok"] = json!(true);
            out
        }
        (Err(e), _) | (_, Err(e)) => fail(e),
    }
}

pub async fn door_card_list(root: &Path) -> Value {
    json!({ "ok": true, "cards": waiting_cards(root) })
}

// ─── Bible: a picked style ───

/// What `save_style_card` is asked: a picked style written into the bible.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StyleCard {
    /// `bible/styles/<slug>.md`.
    pub slug: String,
    pub name: String,
    /// The prompt (or condition) that made it — what to reuse.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub negative: Option<String>,
    /// Model / workflow that made it.
    #[serde(default)]
    pub model: Option<String>,
    /// Pictures, relative to the project (copied under `assets/styles/<slug>/`).
    #[serde(default)]
    pub images: Vec<String>,
    /// Why it was picked, in the picker's words.
    #[serde(default)]
    pub why: Option<String>,
    /// The materials it was drawn from.
    #[serde(default)]
    pub refs: Vec<String>,
    /// Scores and notes from the judging step.
    #[serde(default)]
    pub score: Value,
    /// `<flow>/<run>` it came from.
    #[serde(default)]
    pub run: Option<String>,
}

/// Write a style card into the bible. Refuses to overwrite a card a person
/// wrote (one without the generated marker).
pub fn save_style_card(root: &Path, card: &StyleCard) -> Value {
    if !valid_id(&card.slug) {
        return json!({ "ok": false, "note": format!("slug `{}` — use a-z, 0-9, - and _", card.slug) });
    }
    let bible = bible_dir(root);
    let path = bible.join("styles").join(format!("{}.md", card.slug));
    if let Ok(existing) = std::fs::read_to_string(&path) {
        if !existing.contains(CARD_MARK) {
            return json!({ "ok": false, "note": format!("{} was written by hand — pick another slug", rel(root, &path)) });
        }
    }
    let assets_dir = root.join("assets").join("styles").join(&card.slug);
    let mut copied = Vec::new();
    for (i, img) in card.images.iter().enumerate() {
        let src = root.join(img.trim_start_matches('/'));
        let inside = match (src.canonicalize(), root.canonicalize()) {
            (Ok(s), Ok(r)) => s.starts_with(r),
            _ => false,
        };
        if !inside || !src.is_file() {
            return json!({ "ok": false, "note": format!("picture {img} is not a file in the project") });
        }
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let dst = assets_dir.join(format!("{}_{i}.{ext}", card.slug));
        if let Err(e) = std::fs::create_dir_all(&assets_dir).and_then(|_| std::fs::copy(&src, &dst))
        {
            return json!({ "ok": false, "note": format!("copying {img}: {e}") });
        }
        copied.push(rel(root, &dst));
    }
    let md = style_card_md(card, &copied, &path, root);
    if let Err(e) = std::fs::create_dir_all(path.parent().unwrap_or(root))
        .and_then(|_| std::fs::write(&path, md))
    {
        return json!({ "ok": false, "note": format!("writing {}: {e}", rel(root, &path)) });
    }
    json!({ "ok": true, "card": rel(root, &path), "images": copied })
}

/// The bible folder the manifest names (`paths.bible`), default `bible`.
fn bible_dir(root: &Path) -> PathBuf {
    let named = std::fs::read_to_string(root.join("codeg-project.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|m| {
            m.pointer("/paths/bible")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|b| !b.is_empty() && !b.contains(".."));
    root.join(named.unwrap_or_else(|| "bible".into()))
}

const CARD_MARK: &str = "<!-- studio:style-card -->";

fn style_card_md(card: &StyleCard, images: &[String], path: &Path, root: &Path) -> String {
    let up = path
        .parent()
        .and_then(|p| p.strip_prefix(root).ok())
        .map_or(String::new(), |p| "../".repeat(p.components().count()));
    let mut s = format!("# 그림체 — {}\n\n{CARD_MARK}\n\n", card.name);
    for img in images {
        s.push_str(&format!("![{}]({up}{img})\n", card.name));
    }
    s.push('\n');
    let line = |label: &str, v: &Option<String>| {
        v.as_ref()
            .map(|v| format!("- {label}: {v}\n"))
            .unwrap_or_default()
    };
    s.push_str(&line("왜 골랐나", &card.why));
    s.push_str(&line("모델", &card.model));
    s.push_str(&line("실행", &card.run));
    if !card.refs.is_empty() {
        s.push_str(&format!("- 재료: {}\n", card.refs.join(" · ")));
    }
    if let Some(p) = &card.prompt {
        s.push_str(&format!("\n## 프롬프트\n\n```\n{p}\n```\n"));
    }
    if let Some(n) = &card.negative {
        s.push_str(&format!("\n## 빼는 것\n\n```\n{n}\n```\n"));
    }
    if !card.score.is_null() {
        s.push_str(&format!(
            "\n## 채점\n\n```json\n{}\n```\n",
            serde_json::to_string_pretty(&card.score).unwrap_or_default()
        ));
    }
    s
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests;
