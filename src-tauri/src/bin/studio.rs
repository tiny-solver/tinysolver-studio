//! `studio` — the Studio's parts (ops) from the command line.
//!
//!   studio op list            one line per op: id · tool · group · changes · uses · title
//!   studio op list --json     the whole registry (input / output JSON Schema per op)
//!   studio op show <op|tool>  one op, with its schemas, as JSON
//!
//! Everything comes from the op registry ([`codeg_lib::studio_ops`]), the same
//! list the `codeg-mcp` companion builds its `studio_*` tools from.
//!
//!   studio op run <op> ['{json args}'] [--project <name|path>]
//!
//! runs an op on the Studio server (`POST /api/studio/<op>`) — a thin client,
//! the server owns the projects. `STUDIO_URL` (default
//! https://studio.home.tinysolver.me) · `STUDIO_TOKEN`, else `CODEG_TOKEN` in
//! `~/.config/tinysolver-studio/server.env` (the server host's own copy).
//! Prints the outcome JSON; exits 1 when it is `ok: false`.

use std::process::ExitCode;

use codeg_lib::studio_ops::{input_with_project, registry, OpSpec, REGISTRY_JSON};

const USAGE: &str = "usage: studio op list [--json] | studio op show <op|tool> | studio op run <op> ['{json}'] [--project <name|path>]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["op", "list"] => {
            print!("{}", table());
            ExitCode::SUCCESS
        }
        ["op", "list", "--json"] => {
            print!("{REGISTRY_JSON}");
            ExitCode::SUCCESS
        }
        ["op", "show", name] => {
            let reg = registry();
            match reg.find(name).or_else(|| reg.find_tool(name)) {
                Some(spec) => {
                    println!("{}", serde_json::to_string_pretty(&show(spec)).unwrap_or_default());
                    ExitCode::SUCCESS
                }
                None => {
                    eprintln!("studio: no op `{name}` — studio op list shows them");
                    ExitCode::FAILURE
                }
            }
        }
        ["op", "run", op, rest @ ..] => run(op, rest),
        ["-h"] | ["--help"] | ["help"] => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn show(spec: &OpSpec) -> serde_json::Value {
    let mut out = serde_json::to_value(spec).unwrap_or_default();
    out["input"] = input_with_project(spec);
    out["failure"] = registry().failure.clone();
    out
}

fn table() -> String {
    let reg = registry();
    let dash = |v: &[String]| if v.is_empty() { "-".to_string() } else { v.join(",") };
    let rows: Vec<[String; 6]> = reg
        .ops
        .iter()
        .map(|s| {
            [
                s.op.clone(),
                s.tool.clone().unwrap_or_else(|| "(editor)".into()),
                s.group.clone(),
                dash(&s.changes),
                dash(&s.uses),
                s.title.clone(),
            ]
        })
        .collect();
    let head = ["op", "mcp tool", "group", "changes", "uses", "title"].map(String::from);
    let mut width = [0usize; 5];
    for row in std::iter::once(&head).chain(&rows) {
        for (w, cell) in width.iter_mut().zip(row) {
            *w = (*w).max(cell.chars().count());
        }
    }
    let mut out = String::new();
    for row in std::iter::once(&head).chain(&rows) {
        for (w, cell) in width.iter().zip(row) {
            out.push_str(&format!("{cell:<w$}  "));
        }
        out.push_str(&row[5]);
        out.push('\n');
    }
    let mcp = reg.ops.iter().filter(|s| s.tool.is_some()).count();
    out.push_str(&format!(
        "\n{} ops · {mcp} as MCP tools · schema {} · `studio op show <op>` for input/output\n",
        reg.ops.len(),
        reg.schema
    ));
    out
}

const DEFAULT_URL: &str = "https://studio.home.tinysolver.me";

fn token() -> Option<String> {
    if let Some(t) = std::env::var("STUDIO_TOKEN").ok().filter(|t| !t.trim().is_empty()) {
        return Some(t.trim().to_string());
    }
    let conf = dirs::home_dir()?.join(".config/tinysolver-studio/server.env");
    std::fs::read_to_string(conf)
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("CODEG_TOKEN=").map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
}

fn run(op: &str, rest: &[&str]) -> ExitCode {
    let mut args = serde_json::Value::Object(Default::default());
    let mut project = None;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match *a {
            "--project" => project = it.next().map(|p| p.to_string()),
            "--json" => {}
            raw => match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(v @ serde_json::Value::Object(_)) => args = v,
                _ => {
                    eprintln!("studio: arguments must be one JSON object, got `{raw}`");
                    return ExitCode::from(2);
                }
            },
        }
    }
    if let Some(p) = project {
        args["project"] = serde_json::Value::String(p);
    }
    let Some(token) = token() else {
        eprintln!("studio: no token — set STUDIO_TOKEN (Vault secret/tinysolver/studio/server TOKEN)");
        return ExitCode::from(2);
    };
    let base = std::env::var("STUDIO_URL").unwrap_or_else(|_| DEFAULT_URL.into());
    let url = format!("{}/api/studio/{op}", base.trim_end_matches('/'));
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())
        .and_then(|rt| {
            rt.block_on(async {
                let resp = reqwest::Client::new()
                    .post(&url)
                    .bearer_auth(&token)
                    .json(&args)
                    .send()
                    .await
                    .map_err(|e| format!("{url}: {e}"))?;
                let status = resp.status();
                if !status.is_success() {
                    return Err(format!("{url}: HTTP {status}"));
                }
                resp.json::<serde_json::Value>().await.map_err(|e| format!("{url}: {e}"))
            })
        });
    match outcome {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            if v["ok"] == serde_json::Value::Bool(false) {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(e) => {
            eprintln!("studio: {e}");
            ExitCode::FAILURE
        }
    }
}
