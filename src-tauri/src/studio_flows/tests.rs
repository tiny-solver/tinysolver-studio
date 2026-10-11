use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

/// Parts that answer from the arguments: `echo` returns them, `gen` makes a
/// fake picture path, `model_once` scores by the prompt's length, `boom`
/// fails. Every call is counted so reuse can be checked.
#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
}

#[async_trait]
impl Parts for Fake {
    async fn call(&self, op: &str, args: Value) -> Value {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match op {
            "echo" => json!({ "ok": true, "args": args }),
            "gen" => json!({
                "ok": true,
                "path": format!(
                    "assets/gen/{}_{}.png",
                    args["cond"].as_str().unwrap_or("?"),
                    args["model"].as_str().unwrap_or("?")
                ),
                "cost_usd": 0.01,
            }),
            "model_once" => json!({
                "ok": true, "agent": args["agent"], "model": null,
                "output": { "score": args["prompt"].as_str().map_or(0, |p| p.len() % 10) },
                "duration_ms": 5, "cost_usd": 0.002,
            }),
            "boom" => json!({ "ok": false, "note": "it broke" }),
            _ => json!({ "ok": false, "note": format!("unknown op {op}") }),
        }
    }
}

fn project(flows: &[Value]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(FLOWS_DIR)).unwrap();
    for f in flows {
        let id = f["id"].as_str().unwrap();
        std::fs::write(
            flow_path(dir.path(), id),
            serde_json::to_string_pretty(f).unwrap(),
        )
        .unwrap();
    }
    dir
}

fn flow(id: &str, steps: Value) -> Value {
    json!({ "schema": 1, "id": id, "want": { "text": "a test" }, "steps": steps })
}

fn req(flow: &str) -> RunRequest {
    RunRequest {
        flow: flow.into(),
        ..Default::default()
    }
}

fn node<'a>(r: &'a RunRecord, key: &str) -> &'a NodeRecord {
    r.nodes.iter().find(|n| n.key == key).unwrap_or_else(|| {
        panic!(
            "no node {key}: {:?}",
            r.nodes.iter().map(|n| &n.key).collect::<Vec<_>>()
        )
    })
}

#[test]
fn references_resolve_whole_values_paths_and_text() {
    let mut base = Map::new();
    base.insert("inputs".into(), json!({ "models": ["a", "b"], "n": 3 }));
    base.insert(
        "gens".into(),
        json!([{ "img": { "path": "x.png" } }, { "img": { "path": "y.png" } }]),
    );
    let scope = Scope::new(base);
    assert_eq!(
        resolve(&json!("${inputs.models}"), &scope).unwrap(),
        json!(["a", "b"])
    );
    assert_eq!(
        resolve(&json!("${inputs.models[1]}"), &scope).unwrap(),
        json!("b")
    );
    assert_eq!(
        resolve(&json!("${gens.*.img.path}"), &scope).unwrap(),
        json!(["x.png", "y.png"])
    );
    assert_eq!(
        resolve(&json!("n=${inputs.n} m=${inputs.models[0]}"), &scope).unwrap(),
        json!("n=3 m=a")
    );
    assert_eq!(
        resolve(&json!({ "k": ["${inputs.n}"] }), &scope).unwrap(),
        json!({ "k": [3] })
    );
    assert_eq!(
        resolve(&json!("${inputs.missing}"), &scope).unwrap(),
        Value::Null
    );
    assert!(resolve(&json!("${nope.x}"), &scope)
        .unwrap_err()
        .contains("nothing named `nope`"));
    assert!(resolve(&json!("${inputs.models.x}"), &scope).is_err());
}

#[test]
fn conditions() {
    let mut base = Map::new();
    base.insert(
        "s".into(),
        json!({ "best": 7, "name": "crayon", "list": [] }),
    );
    let scope = Scope::new(base);
    let c = |v: Value| eval_cond(&serde_json::from_value(v).unwrap(), &scope).unwrap();
    assert!(c(json!({ "left": "${s.best}", "op": "gte", "right": 7 })));
    assert!(!c(json!({ "left": "${s.best}", "op": "gt", "right": "7" })));
    assert!(c(
        json!({ "left": "${s.name}", "op": "in", "right": ["pencil", "crayon"] })
    ));
    assert!(c(json!({ "left": "${s.list}", "op": "falsy" })));
    assert!(c(json!({ "all": [
        { "left": "${s.best}", "op": "eq", "right": 7 },
        { "not": { "left": "${s.nope}", "op": "exists" } }
    ] })));
    assert!(c(json!({ "any": [
        { "left": 1, "op": "eq", "right": 2 },
        { "left": "${s.name}", "op": "ne", "right": "x" }
    ] })));
}

#[test]
fn validate_catches_problems() {
    let doc: FlowDoc = serde_json::from_value(json!({
        "schema": 1, "id": "Bad Id", "want": { "text": "" },
        "steps": [
            { "id": "a", "kind": "op", "op": "echo" },
            { "id": "a", "kind": "set", "value": 1 },
            { "id": "r", "kind": "repeat", "max": 0, "steps": [] },
            { "id": "ag", "kind": "agent", "agent": "claude", "goal": "fix it", "tools": ["fly"] },
            { "id": "inputs", "kind": "set", "value": 1 }
        ]
    }))
    .unwrap();
    let issues = validate(&doc).join("\n");
    for needle in [
        "id `Bad Id`",
        "want.text",
        "`a` is used twice",
        "repeat max",
        "ag: tool `fly` is not a Studio part",
        "reserved",
    ] {
        assert!(issues.contains(needle), "{needle} missing in:\n{issues}");
    }
}

#[test]
fn agent_spec_keeps_its_fields_and_node_keeps_its_own() {
    let n: Node = serde_json::from_value(json!({
        "id": "ag", "kind": "agent", "agent": "claude", "goal": "g", "note": "hi",
        "keep_going": true, "stop": { "max_turns": 3 }
    }))
    .unwrap();
    assert_eq!(n.note.as_deref(), Some("hi"));
    assert!(n.keep_going);
    let NodeKind::Agent { spec } = &n.kind else {
        panic!("not an agent node")
    };
    assert_eq!(spec["goal"], json!("g"));
    assert_eq!(spec["stop"]["max_turns"], json!(3));
    let back: Node = serde_json::from_value(serde_json::to_value(&n).unwrap()).unwrap();
    assert_eq!(back, n);
}

#[tokio::test]
async fn agent_node_without_agent_sessions_fails_with_a_note() {
    // No host is installed in tests (the CLI is the same): the node says so
    // instead of hanging, and its record carries the outcome.
    let dir = project(&[flow(
        "ag",
        json!([
            { "id": "fix", "kind": "agent", "agent": "claude", "goal": "fix ${inputs.scene}",
              "tools": ["read_scene"], "input": { "scene": "${inputs.scene}" } }
        ]),
    )]);
    let mut r = req("ag");
    r.inputs.insert("scene".into(), json!("intro"));
    let run = run_flow(dir.path(), Arc::new(Fake::default()), &r).await.unwrap();
    assert_eq!(run.status, Status::Failed);
    let n = node(&run, "fix");
    assert_eq!(n.who.as_deref(), Some("agent:claude"));
    assert_eq!(n.input["goal"], json!("fix intro"));
    assert_eq!(n.output["ok"], json!(false));
    assert!(n.note.as_deref().unwrap_or_default().contains("codeg-server"), "{:?}", n.note);
}

#[tokio::test]
async fn sequence_feeds_outputs_forward_and_records_each_node() {
    let dir = project(&[flow(
        "seq",
        json!([
            { "id": "a", "kind": "op", "op": "echo", "args": { "x": "${inputs.x}" } },
            { "id": "b", "kind": "set", "value": { "got": "${a.args.x}" } },
            { "id": "c", "kind": "model", "args": { "agent": "claude", "prompt": "len ${b.got}", "schema": {} } }
        ]),
    )]);
    let fake = Arc::new(Fake::default());
    let mut r = req("seq");
    r.inputs.insert("x".into(), json!("hello"));
    let run = run_flow(dir.path(), fake.clone(), &r).await.unwrap();
    assert_eq!(run.status, Status::Done, "{:?}", run.note);
    assert_eq!(node(&run, "b").output, json!({ "got": "hello" }));
    assert_eq!(node(&run, "c").input["prompt"], json!("len hello"));
    assert_eq!(node(&run, "c").who.as_deref(), Some("claude"));
    assert_eq!(node(&run, "c").cost_usd, Some(0.002));
    assert!((run.cost_usd - 0.002).abs() < 1e-9);
    assert_eq!(run.output["output"]["score"], json!(9));
    let disk = read_run(dir.path(), "seq", &run.id).unwrap();
    assert_eq!(disk, run);
}

#[tokio::test]
async fn each_over_a_product_runs_every_pair_and_collects() {
    let dir = project(&[flow(
        "fan",
        json!([
            { "id": "gens", "kind": "each", "limit": 2,
              "over": { "cond": "${inputs.conds}", "model": "${inputs.models}" },
              "steps": [{ "id": "img", "kind": "op", "op": "gen", "args": { "cond": "${cond}", "model": "${model}" } }] },
            { "id": "paths", "kind": "set", "value": "${gens.*.img.path}" }
        ]),
    )]);
    let fake = Arc::new(Fake::default());
    let mut r = req("fan");
    r.inputs
        .insert("conds".into(), json!(["pencil", "crayon", "sticker"]));
    r.inputs.insert("models".into(), json!(["flux", "sdxl"]));
    let run = run_flow(dir.path(), fake.clone(), &r).await.unwrap();
    assert_eq!(run.status, Status::Done, "{:?}", run.note);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 6);
    let paths = node(&run, "paths").output.as_array().unwrap().clone();
    assert_eq!(paths.len(), 6);
    assert_eq!(paths[0], json!("assets/gen/pencil_flux.png"));
    assert_eq!(paths[5], json!("assets/gen/sticker_sdxl.png"));
    assert_eq!(
        node(&run, "gens[3].img").input,
        json!({ "cond": "crayon", "model": "sdxl" })
    );
    let gens = &node(&run, "gens").output;
    assert_eq!(gens[1]["model"], json!("sdxl"));
    assert_eq!(gens[1]["index"], json!(1));
    assert!((run.cost_usd - 0.06).abs() < 1e-9);
}

#[tokio::test]
async fn parallel_if_and_repeat() {
    let dir = project(&[flow(
        "shape",
        json!([
            { "id": "p", "kind": "parallel", "branches": [
                [{ "id": "l", "kind": "set", "value": 1 }],
                [{ "id": "r", "kind": "set", "value": 2 }]
            ] },
            { "id": "pick", "kind": "if", "when": { "left": "${p[1].r}", "op": "gt", "right": "${p[0].l}" },
              "then": [{ "id": "yes", "kind": "set", "value": "right" }],
              "else": [{ "id": "no", "kind": "set", "value": "left" }] },
            { "id": "loop", "kind": "repeat", "max": 5,
              "until": { "left": "${round}", "op": "gte", "right": 2 },
              "steps": [{ "id": "step", "kind": "op", "op": "echo", "args": { "round": "${round}" } }] }
        ]),
    )]);
    let run = run_flow(dir.path(), Arc::new(Fake::default()), &req("shape"))
        .await
        .unwrap();
    assert_eq!(run.status, Status::Done, "{:?}", run.note);
    assert_eq!(node(&run, "pick").output, json!("right"));
    assert!(run.nodes.iter().all(|n| n.key != "pick.no"));
    assert_eq!(node(&run, "loop").output["rounds"], json!(3));
    assert_eq!(node(&run, "loop#2.step").input, json!({ "round": 2 }));
}

#[tokio::test]
async fn failure_stops_the_run_unless_keep_going() {
    let dir = project(&[
        flow(
            "bad",
            json!([{ "id": "x", "kind": "op", "op": "boom" }, { "id": "y", "kind": "set", "value": 1 }]),
        ),
        flow(
            "soft",
            json!([{ "id": "each", "kind": "each", "over": ["echo", "boom"], "steps": [
                { "id": "x", "kind": "op", "op": "boom", "keep_going": true }
            ] }]),
        ),
    ]);
    let fake = Arc::new(Fake::default());
    let run = run_flow(dir.path(), fake.clone(), &req("bad"))
        .await
        .unwrap();
    assert_eq!(run.status, Status::Failed);
    assert!(run.note.as_deref().unwrap().contains("x: it broke"));
    assert!(run.nodes.iter().all(|n| n.key != "y"));

    let run = run_flow(dir.path(), fake, &req("soft")).await.unwrap();
    assert_eq!(run.status, Status::Done);
    assert_eq!(node(&run, "each[0].x").status, Status::Failed);
    assert_eq!(node(&run, "each").output[1]["x"]["ok"], json!(false));
}

#[tokio::test]
async fn human_card_stops_and_answer_resumes_without_calling_again() {
    let dir = project(&[flow(
        "pick",
        json!([
            { "id": "gens", "kind": "each", "over": "${inputs.conds}", "as": "cond",
              "steps": [{ "id": "img", "kind": "op", "op": "gen", "args": { "cond": "${cond}", "model": "m" } }] },
            { "id": "choose", "kind": "human", "ask": "Which of ${inputs.conds}?", "show": "${gens.*.img.path}", "pick": "one" },
            { "id": "card", "kind": "op", "op": "echo", "args": { "picked": "${choose.item}", "why": "${choose.note}" } }
        ]),
    )]);
    let fake = Arc::new(Fake::default());
    let mut r = req("pick");
    r.inputs.insert("conds".into(), json!(["pencil", "crayon"]));
    let run = run_flow(dir.path(), fake.clone(), &r).await.unwrap();
    assert_eq!(run.status, Status::Waiting);
    assert_eq!(run.waiting.len(), 1);
    assert_eq!(run.waiting[0].key, "choose");
    assert_eq!(
        run.waiting[0].show,
        json!(["assets/gen/pencil_m.png", "assets/gen/crayon_m.png"])
    );
    assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    assert_eq!(waiting_cards(dir.path()).len(), 1);

    let err = answer(
        dir.path(),
        fake.clone(),
        "pick",
        &run.id,
        "choose",
        json!(5),
    )
    .await
    .unwrap_err();
    assert!(err.contains("out of range"), "{err}");
    assert!(
        answer(dir.path(), fake.clone(), "pick", &run.id, "nope", json!(0))
            .await
            .is_err()
    );

    let done = answer(
        dir.path(),
        fake.clone(),
        "pick",
        &run.id,
        "choose",
        json!({ "index": 1, "note": "warmer" }),
    )
    .await
    .unwrap();
    assert_eq!(done.status, Status::Done, "{:?}", done.note);
    assert!(done.waiting.is_empty());
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        3,
        "the generations were reused, only `card` ran"
    );
    assert_eq!(
        node(&done, "card").input,
        json!({ "picked": "assets/gen/crayon_m.png", "why": "warmer" })
    );
    assert_eq!(node(&done, "choose").who.as_deref(), Some("human"));
    assert!(waiting_cards(dir.path()).is_empty());
    assert!(
        answer(dir.path(), fake, "pick", &run.id, "choose", json!(0))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn from_run_reuses_unchanged_nodes_and_compare_shows_the_change() {
    let steps = |prompt: &str| {
        json!([
            { "id": "gens", "kind": "each", "over": "${inputs.conds}", "as": "cond",
              "steps": [{ "id": "img", "kind": "op", "op": "gen", "args": { "cond": "${cond}", "model": "m" } }] },
            { "id": "score", "kind": "model", "args": { "agent": "claude", "prompt": prompt, "schema": {} } },
            { "id": "ok", "kind": "human", "ask": "go on?", "pick": "ok" }
        ])
    };
    let dir = project(&[json!({
        "schema": 1, "id": "cmp", "want": { "text": "w" }, "inputs": { "conds": ["a", "b"] },
        "steps": steps("judge ${gens.*.img.path}")
    })]);
    let fake = Arc::new(Fake::default());
    let first = run_flow(dir.path(), fake.clone(), &req("cmp"))
        .await
        .unwrap();
    let first = answer(
        dir.path(),
        fake.clone(),
        "cmp",
        &first.id,
        "ok",
        json!(true),
    )
    .await
    .unwrap();
    assert_eq!(first.status, Status::Done);
    assert_eq!(fake.calls.load(Ordering::SeqCst), 3);

    // Change only the scoring prompt.
    let mut doc = read_flow(dir.path(), "cmp").unwrap();
    doc.steps = serde_json::from_value(steps("judge harder ${gens.*.img.path}")).unwrap();
    std::fs::write(
        flow_path(dir.path(), "cmp"),
        serde_json::to_string(&doc).unwrap(),
    )
    .unwrap();

    let mut r = req("cmp");
    r.from_run = Some(first.id.clone());
    r.label = Some("harder judge".into());
    let second = run_flow(dir.path(), fake.clone(), &r).await.unwrap();
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        4,
        "only the changed score node ran"
    );
    assert_eq!(
        node(&second, "gens[0].img").reused_from.as_deref(),
        Some(first.id.as_str())
    );
    assert!(node(&second, "score").reused_from.is_none());
    // The card asks the same thing → its answer carries over.
    assert_eq!(second.status, Status::Done, "{:?}", second.waiting);
    assert!(
        (second.cost_usd - 0.002).abs() < 1e-9,
        "reused costs are not counted again: {}",
        second.cost_usd
    );

    let cmp = compare(&first, &second);
    assert_eq!(cmp["nodes_changed"], json!(["score"]));
    let rows = cmp["rows"].as_array().unwrap();
    let row = rows.iter().find(|r| r["key"] == "score").unwrap();
    assert_eq!(row["flow_changed"], json!(true));
    assert_eq!(row["input_changed"], json!(true));
    let row = rows.iter().find(|r| r["key"] == "gens[1].img").unwrap();
    assert_eq!(row["flow_changed"], json!(false));
    assert_eq!(row["output_changed"], json!(false));

    assert_eq!(list_runs(dir.path(), Some("cmp")).len(), 2);
    assert_eq!(list_flows(dir.path())[0]["id"], json!("cmp"));
}

#[tokio::test]
async fn sub_flow_runs_inline_with_its_own_inputs() {
    let dir = project(&[
        json!({ "schema": 1, "id": "inner", "want": { "text": "w" }, "inputs": { "x": 1 },
                "steps": [{ "id": "e", "kind": "op", "op": "echo", "args": { "x": "${inputs.x}", "y": "${inputs.y}" } }],
                "output": "${e.args}" }),
        flow(
            "outer",
            json!([{ "id": "sub", "kind": "flow", "flow": "inner", "inputs": { "y": 2 } }]),
        ),
        flow(
            "loop",
            json!([{ "id": "me", "kind": "flow", "flow": "loop" }]),
        ),
    ]);
    let fake = Arc::new(Fake::default());
    let run = run_flow(dir.path(), fake.clone(), &req("outer"))
        .await
        .unwrap();
    assert_eq!(run.status, Status::Done, "{:?}", run.note);
    assert_eq!(node(&run, "sub").output, json!({ "x": 1, "y": 2 }));
    assert!(run.nodes.iter().any(|n| n.key == "sub>e"));
    assert!(run.sub_flows.contains_key("inner"));

    let run = run_flow(dir.path(), fake, &req("loop")).await.unwrap();
    assert_eq!(run.status, Status::Failed);
    assert!(run.note.unwrap().contains("nest deeper"));
}

#[tokio::test]
async fn live_card_is_answered_without_replay() {
    let dir = project(&[flow(
        "live",
        json!([{ "id": "a", "kind": "set", "value": 1 }]),
    )]);
    let run = prepare(dir.path(), &req("live")).unwrap();
    let ex = Arc::new(Exec {
        root: dir.path().to_path_buf(),
        parts: Arc::new(Fake::default()),
        prior: HashMap::new(),
        answers: BTreeMap::new(),
        state: Mutex::new(run.clone()),
    });
    let card = Card {
        key: "ag.perm1".into(),
        ask: "write file?".into(),
        show: json!(["allow", "deny"]),
        pick: Pick::One,
        since: now(),
    };
    let waiter = tokio::spawn({
        let ex = ex.clone();
        async move { ex.ask_live(card).await }
    });
    let mut waiting = false;
    for _ in 0..200 {
        if read_run(dir.path(), "live", &run.id).is_ok_and(|r| r.status == Status::Waiting) {
            waiting = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(waiting);
    answer(
        dir.path(),
        Arc::new(Fake::default()),
        "live",
        &run.id,
        "ag.perm1",
        json!(0),
    )
    .await
    .unwrap();
    let got = waiter.await.unwrap().unwrap();
    assert_eq!(got, json!({ "index": 0, "item": "allow" }));
    let disk = read_run(dir.path(), "live", &run.id).unwrap();
    assert!(disk.waiting.is_empty());
    assert_eq!(disk.answers["ag.perm1"]["item"], json!("allow"));
}

#[test]
fn style_card_goes_into_the_bible_with_its_pictures() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("assets/gen")).unwrap();
    std::fs::write(root.join("assets/gen/a.png"), b"png").unwrap();
    let card = StyleCard {
        slug: "crayon-soft".into(),
        name: "크레용 부드럽게".into(),
        prompt: Some("crayon texture, soft".into()),
        negative: None,
        model: Some("flux".into()),
        images: vec!["assets/gen/a.png".into()],
        why: Some("따뜻해서".into()),
        refs: vec!["ggul 크레용".into()],
        score: json!({ "score": 8 }),
        run: Some("style-find/20261011-1".into()),
    };
    let out = save_style_card(root, &card);
    assert_eq!(out["ok"], json!(true), "{out}");
    let md = std::fs::read_to_string(root.join("bible/styles/crayon-soft.md")).unwrap();
    assert!(md.contains("# 그림체 — 크레용 부드럽게"));
    assert!(
        md.contains("](../../assets/styles/crayon-soft/crayon-soft_0.png)"),
        "{md}"
    );
    assert!(root
        .join("assets/styles/crayon-soft/crayon-soft_0.png")
        .is_file());
    // A generated card may be rewritten; a hand-written one is left alone.
    assert_eq!(save_style_card(root, &card)["ok"], json!(true));
    std::fs::write(root.join("bible/styles/crayon-soft.md"), "# mine").unwrap();
    assert_eq!(save_style_card(root, &card)["ok"], json!(false));
    // Pictures outside the project are refused.
    let mut outside = card.clone();
    outside.slug = "other".into();
    outside.images = vec!["../../etc/passwd".into()];
    assert_eq!(save_style_card(root, &outside)["ok"], json!(false));
}

/// The first flow, as shipped: parts that draw a file per call (one fails),
/// a judge that scores in order, and the real bible writer.
struct StyleFake {
    root: PathBuf,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl Parts for StyleFake {
    async fn call(&self, op: &str, args: Value) -> Value {
        self.calls.lock().unwrap().push(op.to_string());
        match op {
            "list_assets" => json!({ "ok": true, "assets": [] }),
            "generate_asset" => {
                let id = args["id"].as_str().unwrap().to_string();
                assert!(!id.contains("2026"), "a run id in the args defeats reuse: {id}");
                if id.ends_with("nyam-pastel-lowpoly-qwen") {
                    return json!({ "ok": false, "note": "generator busy" });
                }
                assert!(args["from"].as_str().unwrap().starts_with("ref-"));
                let path = format!("assets/gen/{id}.png");
                std::fs::create_dir_all(self.root.join("assets/gen")).unwrap();
                std::fs::write(self.root.join(&path), b"png").unwrap();
                json!({ "ok": true, "asset": { "id": id, "source": { "provider": args["provider"] } }, "path": path })
            }
            "model_once" => {
                let images = args["images"].as_array().unwrap();
                assert_eq!(args["agent"], json!("claude"));
                let scores: Vec<Value> = images
                    .iter()
                    .enumerate()
                    .map(|(i, p)| json!({ "index": i, "path": p, "score": i, "why": "ok" }))
                    .collect();
                json!({ "ok": true, "output": { "scores": scores, "best": images.len() - 1 }, "cost_usd": 0.05 })
            }
            "style_card_save" => {
                let card: StyleCard = serde_json::from_value(args).unwrap();
                save_style_card(&self.root, &card)
            }
            other => panic!("style-find called an unexpected part {other}"),
        }
    }
}

#[tokio::test]
async fn style_find_runs_to_a_bible_card() {
    let doc: Value = serde_json::from_str(STYLE_FIND_FLOW).unwrap();
    let typed: FlowDoc = serde_json::from_value(doc.clone()).unwrap();
    assert!(validate(&typed).is_empty(), "{:?}", validate(&typed));
    let dir = project(&[doc]);
    let fake = Arc::new(StyleFake { root: dir.path().to_path_buf(), calls: Mutex::new(vec![]) });
    let run = run_flow(dir.path(), fake.clone(), &req("style-find")).await.unwrap();
    assert_eq!(run.status, Status::Waiting, "{:?} {:?}", run.note, run.nodes.iter().map(|n| (&n.key, &n.note)).collect::<Vec<_>>());
    // 4 styles × 2 models, one failed and filtered out.
    let made = node(&run, "made").output.as_array().unwrap().clone();
    assert_eq!(made.len(), 7);
    assert_eq!(node(&run, "score").input["images"].as_array().unwrap().len(), 7);
    let card = &run.waiting[0];
    assert_eq!(card.key, "pick");
    assert!(card.ask.contains("6번"), "{}", card.ask);
    assert_eq!(card.show.as_array().unwrap().len(), 7);

    let done = answer(dir.path(), fake.clone(), "style-find", &run.id, "pick", json!({ "index": 2, "note": "선이 살아 있다" }))
        .await
        .unwrap();
    assert_eq!(done.status, Status::Done, "{:?}", done.note);
    let picked = &made[2];
    let slug = format!("{}-{}", picked["style_id"].as_str().unwrap(), picked["model_id"].as_str().unwrap());
    let md = std::fs::read_to_string(dir.path().join(format!("bible/styles/{slug}.md"))).unwrap();
    assert!(md.contains("선이 살아 있다"), "{md}");
    assert!(md.contains(&format!("style-find/{}", run.id)));
    assert_eq!(done.output["card"], json!(format!("bible/styles/{slug}.md")));
    // Resuming did not draw again.
    let calls = fake.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| *c == "generate_asset").count(), 8);
    assert_eq!(calls.iter().filter(|c| *c == "model_once").count(), 1);
}
