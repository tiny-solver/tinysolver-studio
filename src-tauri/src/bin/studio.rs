//! `studio` — the Studio's parts (ops) from the command line.
//!
//!   studio op list            one line per op: id · tool · group · changes · uses · title
//!   studio op list --json     the whole registry (input / output JSON Schema per op)
//!   studio op show <op|tool>  one op, with its schemas, as JSON
//!
//! Everything comes from the op registry ([`codeg_lib::studio_ops`]), the same
//! list the `codeg-mcp` companion builds its `studio_*` tools from. Running an
//! op goes through the server's API (next step), not this listing.

use std::process::ExitCode;

use codeg_lib::studio_ops::{input_with_project, registry, OpSpec, REGISTRY_JSON};

const USAGE: &str = "usage: studio op list [--json] | studio op show <op|tool>";

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
