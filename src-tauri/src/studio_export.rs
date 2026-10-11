//! Export one flow run as a model-pick comparison round (layers L5).
//!
//! The Studio keeps the making — flows and their runs (`runs/<flow>/<run>/`);
//! model-pick shows results. This turns one run into a model-pick round,
//! `rounds/<date>-<id>/round.json` (shape `model-pick-round/2`) plus `media/`,
//! in a model-pick checkout. Publishing stays model-pick's own step
//! (`tool/publish.sh`, LAN · Vault): this only writes the folder and, when
//! asked, runs `publish.sh --dry-run`, which checks every round.
//!
//! model-pick's rules hold here rather than being left to the caller:
//! - a round starts `internal: true` — dev only; the owner decides on making
//!   it public (and a codex line, the owner's personal subscription, never is);
//! - every output is marked as made by AI — summary, notes, `internal_note`;
//! - the task must be in model-pick `tasks.json` and every model in
//!   `models.json` (by id) — a missing one stops the export with a note that
//!   says to add it there first.
//!
//! Two halves: [`Sheet`] is what a round needs (inputs × models → results),
//! independent of how a run is recorded; [`sheet_from_run`] reads a run into
//! one. The round writer ([`write_round`]) only knows the sheet.
//!
//! Plan: my-devops `docs/plans/tinysolver/studio-layers.md` ① 내보내기 · L5.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Where runs are recorded, from the project root.
pub const RUNS_DIR: &str = "runs";
/// The round shape this writes.
pub const ROUND_FORMAT: &str = "model-pick-round/2";
/// Said on every round this writes.
pub const AI_MADE: &str = "결과는 모두 AI 가 만든 것이다";
const DRY_RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// What `export_round` is asked for.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct ExportRequest {
    /// The flow id (`flows/<flow>.flow.json`, `runs/<flow>/`).
    pub flow: String,
    /// The run id (`runs/<flow>/<run>/`).
    pub run: String,
    /// The model-pick checkout. Default `$MODEL_PICK_DIR`, else
    /// `~/tinysolver.me/model-pick`.
    #[serde(default)]
    pub model_pick: Option<String>,
    /// The round's id after the date (`rounds/<date>-<id>/`). Default
    /// `<flow>-<run>`.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// The model-pick task id. Default: the run's, else `text-to-image`.
    #[serde(default)]
    pub task: Option<String>,
    /// The run's model names → model-pick `models.json` ids, for names that
    /// differ (a genai workflow name, say).
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    /// Replace an existing round folder of the same id.
    #[serde(default)]
    pub overwrite: bool,
    /// Run model-pick `tool/publish.sh --dry-run` after writing.
    #[serde(default)]
    pub check: bool,
}

/// One input of the round — a row of the comparison (a condition, a prompt).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SheetInput {
    pub id: String,
    /// A short label (the condition's name).
    pub kind: String,
    /// What was wanted, in people's words.
    pub text: String,
    /// The instruction the models were given, when it differs from `text`.
    #[serde(default)]
    pub prompt: Option<String>,
    /// Pictures given with this input only (a style's reference picture),
    /// relative to the project root, with a label.
    #[serde(default)]
    pub refs: Vec<(PathBuf, String)>,
}

/// One result: an input drawn by a model.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SheetResult {
    pub input: String,
    /// The model as the run names it (mapped to a `models.json` id later).
    pub model: String,
    /// The result file, absolute or relative to the run folder. `None` for a
    /// text result.
    #[serde(default)]
    pub file: Option<PathBuf>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub secs: Option<f64>,
    #[serde(default)]
    pub cost_krw: Option<f64>,
    /// The judging model's score and reason.
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub why: Option<String>,
    /// Picked on a `human` node's card.
    #[serde(default)]
    pub picked: bool,
    /// What was actually sent to the model.
    #[serde(default)]
    pub sent: Option<Value>,
}

/// What a round needs from a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub flow: String,
    pub flow_name: String,
    pub run: String,
    /// `YYYY-MM-DD` (KST) the run started.
    pub date: String,
    /// The flow's `want` line.
    #[serde(default)]
    pub want: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    /// Short chips (조건).
    #[serde(default)]
    pub conditions: Vec<String>,
    /// Materials every input was given (reference pictures), absolute or
    /// relative to the run folder, with a label.
    #[serde(default)]
    pub refs: Vec<(PathBuf, String)>,
    pub inputs: Vec<SheetInput>,
    pub results: Vec<SheetResult>,
    /// The judging model, when results carry scores.
    #[serde(default)]
    pub judge: Option<String>,
    /// The notes left with the picks — shown with the verdict, so a test
    /// answer reads as one.
    #[serde(default)]
    pub pick_notes: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

fn fail(note: impl Into<String>) -> Value {
    json!({ "ok": false, "note": note.into() })
}

/// The model-pick checkout to write into.
pub fn model_pick_dir(req: &ExportRequest) -> PathBuf {
    if let Some(d) = req.model_pick.as_deref().filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::var_os("MODEL_PICK_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    dirs::home_dir()
        .unwrap_or_default()
        .join("tinysolver.me/model-pick")
}

/// A path segment we are willing to put in a folder name.
fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `foo.png` → `png`; nothing for no extension.
fn ext_of(p: &Path) -> String {
    p.extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default()
}

fn resolve(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// A file name piece from a model id (`gpt-image-2.5-flare` stays,
/// `a/b c` → `a-b-c`).
fn piece(s: &str) -> String {
    let p: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    p.trim_matches('-').to_string()
}

fn read_json(p: &Path) -> Result<Value, String> {
    let s = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display()))
}

/// model-pick's registers: task ids, and model id → the tasks it can do.
struct Registers {
    tasks: BTreeSet<String>,
    models: BTreeMap<String, BTreeSet<String>>,
}

fn registers(mp: &Path) -> Result<Registers, String> {
    let t = read_json(&mp.join("tasks.json"))?;
    let m = read_json(&mp.join("models.json"))?;
    let tasks = t["tasks"]
        .as_array()
        .ok_or("tasks.json 에 tasks 가 없다")?
        .iter()
        .filter_map(|x| x["id"].as_str().map(String::from))
        .collect();
    let models = m["models"]
        .as_array()
        .ok_or("models.json 에 models 가 없다")?
        .iter()
        .filter_map(|x| {
            let id = x["id"].as_str()?.to_string();
            let can = x["tasks"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Some((id, can))
        })
        .collect();
    Ok(Registers { tasks, models })
}

/// A subscription line the owner pays for personally — never public.
fn is_personal_subscription(model_id: &str) -> bool {
    model_id.starts_with("codex")
}

/// Write `rounds/<date>-<id>/` from a sheet. `base` (the project root)
/// resolves the sheet's relative files. Returns the op's outcome (`ok` with the round id, folder,
/// counts — or a failure note).
pub fn write_round(sheet: &Sheet, base: &Path, req: &ExportRequest, mp: &Path) -> Value {
    let regs = match registers(mp) {
        Ok(r) => r,
        Err(e) => return fail(format!("model-pick 명부를 못 읽었다 — {e}")),
    };
    let task = req
        .task
        .clone()
        .or_else(|| sheet.task.clone())
        .unwrap_or_else(|| "text-to-image".into());
    if !regs.tasks.contains(&task) {
        return fail(format!(
            "model-pick tasks.json 에 없는 과제 '{task}' — 거기 먼저 넣는다(model-pick repo 에서 work.sh start → land)"
        ));
    }
    let tail = req
        .id
        .clone()
        .unwrap_or_else(|| format!("{}-{}", sheet.flow, short_run(&sheet.run)));
    if !is_slug(&tail) {
        return fail(format!(
            "판 id '{tail}' 는 영문 · 숫자 · - · _ 만 — id 로 따로 준다"
        ));
    }
    let round_id = format!("{}-{tail}", sheet.date);
    if sheet.results.is_empty() {
        return fail("이 실행에는 내보낼 결과가 없다 — 생성 노드가 끝난 실행을 고른다");
    }

    // run model name → models.json id
    let map_model = |m: &str| req.models.get(m).cloned().unwrap_or_else(|| m.to_string());
    let mut model_ids: Vec<String> = Vec::new();
    for r in &sheet.results {
        let id = map_model(&r.model);
        if !model_ids.contains(&id) {
            model_ids.push(id);
        }
    }
    let missing: Vec<&String> = model_ids
        .iter()
        .filter(|m| !regs.models.contains_key(*m))
        .collect();
    if !missing.is_empty() {
        return fail(format!(
            "model-pick models.json 에 없는 모델 {missing:?} — 거기 먼저 넣거나(model-pick repo 에서 work.sh start → land) models 로 이름을 잇는다"
        ));
    }
    if let Some(m) = model_ids.iter().find(|m| !regs.models[*m].contains(&task)) {
        return fail(format!(
            "models.json 에 {m} 는 {task} 를 못 한다고 적혀 있다 — 그 줄 tasks 에 먼저"
        ));
    }
    let input_ids: BTreeSet<&str> = sheet.inputs.iter().map(|i| i.id.as_str()).collect();
    if let Some(r) = sheet
        .results
        .iter()
        .find(|r| !input_ids.contains(r.input.as_str()))
    {
        return fail(format!("결과가 모르는 넣은 것 '{}' 를 가리킨다", r.input));
    }

    let dir = mp.join("rounds").join(&round_id);
    if dir.exists() {
        if !req.overwrite {
            return fail(format!("rounds/{round_id} 가 이미 있다 — 다시 쓰려면 overwrite: true · 새 판이면 id 를 바꾼다"));
        }
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            return fail(format!("rounds/{round_id} 를 못 지웠다 — {e}"));
        }
    }
    let media = dir.join("media");
    if let Err(e) = std::fs::create_dir_all(&media) {
        return fail(format!("{}: {e}", media.display()));
    }

    let copy = |from: &Path, name: String| -> Result<String, String> {
        let src = resolve(base, from);
        if !src.is_file() {
            return Err(format!("없는 파일 {}", src.display()));
        }
        let name = format!("{name}{}", ext_of(&src));
        std::fs::copy(&src, media.join(&name)).map_err(|e| format!("{}: {e}", src.display()))?;
        Ok(format!("media/{name}"))
    };
    let undo = |dir: &Path, note: String| {
        let _ = std::fs::remove_dir_all(dir);
        fail(note)
    };

    let mut refs = Vec::new();
    for (i, (p, label)) in sheet.refs.iter().enumerate() {
        match copy(p, format!("ref-{}", i + 1)) {
            Ok(f) => refs.push(json!({ "file": f, "label": label })),
            Err(e) => return undo(&dir, e),
        }
    }

    let scored = sheet.results.iter().any(|r| r.score.is_some());
    let picked_any = sheet.results.iter().any(|r| r.picked);
    let mut outputs = Vec::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for r in &sheet.results {
        let model = map_model(&r.model);
        let mut o = Map::new();
        o.insert("input".into(), json!(r.input));
        o.insert("model".into(), json!(model));
        if let Some(f) = &r.file {
            let base = format!("{}-{}", piece(&r.input), piece(&model));
            let n = seen.entry(base.clone()).or_default();
            *n += 1;
            let name = if *n == 1 { base } else { format!("{base}-{n}") };
            match copy(f, name) {
                Ok(f) => o.insert("file".into(), json!(f)),
                Err(e) => return undo(&dir, e),
            };
        } else if let Some(t) = &r.text {
            o.insert("text".into(), json!(t));
        } else {
            return undo(
                &dir,
                format!("결과 {} × {} 에 파일도 글도 없다", r.input, r.model),
            );
        }
        if let Some(s) = r.secs {
            o.insert("secs".into(), json!((s * 10.0).round() / 10.0));
        }
        if let Some(c) = r.cost_krw {
            o.insert("cost_krw".into(), json!(c));
        }
        if let Some(w) = &r.why {
            o.insert("judge".into(), json!(w));
        }
        let mut checks = Map::new();
        if let Some(s) = r.score {
            checks.insert("ai_score".into(), json!(s));
        }
        if picked_any {
            checks.insert("picked".into(), json!(u8::from(r.picked)));
        }
        if !checks.is_empty() {
            o.insert("checks".into(), Value::Object(checks));
        }
        if let Some(s) = &r.sent {
            o.insert("sent".into(), s.clone());
        }
        outputs.push(Value::Object(o));
    }

    let mut models = Vec::new();
    for m in &model_ids {
        let rs: Vec<&SheetResult> = sheet
            .results
            .iter()
            .filter(|r| &map_model(&r.model) == m)
            .collect();
        let costs: Vec<f64> = rs.iter().filter_map(|r| r.cost_krw).collect();
        let mut e = Map::new();
        e.insert("id".into(), json!(m));
        if !costs.is_empty() && task.contains("image") {
            e.insert(
                "cost_per_image_krw".into(),
                json!((costs.iter().sum::<f64>() / costs.len() as f64 * 10.0).round() / 10.0),
            );
        }
        if is_personal_subscription(m) {
            e.insert(
                "cost".into(),
                json!("ChatGPT 구독(대표님 개인) — 공개하지 않는다"),
            );
        }
        models.push(Value::Object(e));
    }

    let mut checks = Vec::new();
    if scored {
        checks.push(json!({ "id": "ai_score", "by": "ai", "name": "채점 AI 점수",
            "short": "AI 점수", "scale": true, "desc": format!("흐름 안 채점 노드{} 가 매긴 점수 — 운영자 확인 전",
                sheet.judge.as_deref().map(|j| format!("({j})")).unwrap_or_default()) }));
    }
    if picked_any {
        checks.push(
            json!({ "id": "picked", "by": "human", "name": "고르기 카드에서 고름",
            "short": "고름", "desc": "흐름의 고르기 카드에서 사람이 고른 것(답한 사람은 실행 기록에 없다 — 메모를 함께 본다)", "pass": 1 }),
        );
    }

    // the pick: the model of the picked result, else the best average score
    let pick = sheet
        .results
        .iter()
        .find(|r| r.picked)
        .map(|r| map_model(&r.model))
        .or_else(|| {
            model_ids
                .iter()
                .filter_map(|m| {
                    let s: Vec<f64> = sheet
                        .results
                        .iter()
                        .filter(|r| &map_model(&r.model) == m)
                        .filter_map(|r| r.score)
                        .collect();
                    (!s.is_empty()).then(|| (m.clone(), s.iter().sum::<f64>() / s.len() as f64))
                })
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(m, _)| m)
        });

    let personal = model_ids.iter().any(|m| is_personal_subscription(m));
    let mut internal_note = format!(
        "집 안 판(dev 만) — Studio 흐름 '{}' 실행 {} 에서 내보냈다. {AI_MADE}. 공개는 대표님이 정한다.",
        sheet.flow_name, sheet.run
    );
    if personal {
        internal_note
            .push_str(" codex 줄은 대표님 개인 구독이라 공개하지 않는다 — 공개할 땐 그 줄을 뺀다.");
    }
    let title = req
        .title
        .clone()
        .unwrap_or_else(|| format!("{} — Studio 실행 {}", sheet.flow_name, sheet.run));
    let summary = format!(
        "{}넣은 것 {}개 × 모델 {}개 = 결과 {}개. {AI_MADE}{}.",
        sheet
            .want
            .as_deref()
            .map(|w| format!("{w} — "))
            .unwrap_or_default(),
        sheet.inputs.len(),
        model_ids.len(),
        outputs.len(),
        if scored {
            ", 점수는 채점 AI 가 매겼다(운영자 확인 전)"
        } else {
            ""
        },
    );
    let verdict = if picked_any {
        let kind = |id: &str| {
            sheet
                .inputs
                .iter()
                .find(|i| i.id == id)
                .map_or(id.to_string(), |i| i.kind.clone())
        };
        let p = sheet
            .results
            .iter()
            .filter(|r| r.picked)
            .map(|r| format!("{} × {}", kind(&r.input), map_model(&r.model)))
            .collect::<Vec<_>>();
        let note = if sheet.pick_notes.is_empty() {
            String::new()
        } else {
            format!(" — 메모: {}", sheet.pick_notes.join(" · "))
        };
        format!("고르기 카드에서 고른 것: {}{note}", p.join(" · "))
    } else if let Some(p) = &pick {
        format!("채점 AI 평균 점수가 가장 높은 모델: {p} (운영자 확인 전)")
    } else {
        "판정 전 — 결과만 나란히".into()
    };
    let mut notes = vec![
        format!("Studio 흐름 '{}'(runs/{}/{}) 에서 내보낸 판 — 과정(시도 · 바꾼 것)은 Studio 에, 여기엔 결과만", sheet.flow_name, sheet.flow, sheet.run),
        format!("{AI_MADE} — 판정은 이 흐름에서 본 결과이고 모델 전체를 깎아내리지 않는다"),
    ];
    notes.extend(sheet.notes.iter().cloned());

    let mut workflow = Map::new();
    workflow.insert("id".into(), json!(format!("studio-{}", sheet.flow)));
    workflow.insert("name".into(), json!(sheet.flow_name));
    workflow.insert("task".into(), json!(task));
    workflow.insert("conditions".into(), json!(sheet.conditions));
    if let Some(w) = &sheet.want {
        workflow.insert("desc".into(), json!(w));
    }

    let mut inputs: Vec<Value> = Vec::new();
    for i in &sheet.inputs {
        let mut e = json!({ "id": i.id, "kind": i.kind, "text": i.text });
        if let Some(p) = &i.prompt {
            e["prompt"] = json!(p);
        }
        let mut refs = Vec::new();
        for (n, (p, label)) in i.refs.iter().enumerate() {
            match copy(p, format!("{}-ref-{}", piece(&i.id), n + 1)) {
                Ok(f) => refs.push(json!({ "file": f, "label": label })),
                Err(e) => return undo(&dir, e),
            }
        }
        if !refs.is_empty() {
            e["refs"] = json!(refs);
        }
        inputs.push(e);
    }

    let mut round = Map::new();
    round.insert("format".into(), json!(ROUND_FORMAT));
    round.insert("id".into(), json!(round_id));
    round.insert("internal".into(), json!(true));
    round.insert("internal_note".into(), json!(internal_note));
    round.insert("date".into(), json!(sheet.date));
    round.insert("title".into(), json!(title));
    round.insert("summary".into(), json!(summary));
    round.insert("verdict".into(), json!(verdict));
    round.insert(
        "verdict_by".into(),
        json!(if picked_any {
            "고르기 카드 답(사람)"
        } else {
            "AI 보조 판정 · 운영자 확인 전"
        }),
    );
    if let Some(p) = &pick {
        round.insert("pick".into(), json!(p));
    }
    round.insert(
        "source".into(),
        json!({ "studio": { "flow": sheet.flow, "run": sheet.run } }),
    );
    round.insert("workflow".into(), Value::Object(workflow));
    round.insert("models".into(), json!(models));
    if !refs.is_empty() {
        round.insert("refs".into(), json!(refs));
    }
    if !checks.is_empty() {
        round.insert("checks".into(), json!(checks));
    }
    round.insert("inputs".into(), json!(inputs));
    round.insert("outputs".into(), json!(outputs));
    round.insert("notes".into(), json!(notes));

    let body = match serde_json::to_string_pretty(&Value::Object(round)) {
        Ok(s) => s + "\n",
        Err(e) => return undo(&dir, e.to_string()),
    };
    if let Err(e) = std::fs::write(dir.join("round.json"), body) {
        return undo(&dir, format!("round.json: {e}"));
    }
    json!({
        "ok": true,
        "round": round_id,
        "dir": dir.to_string_lossy(),
        "internal": true,
        "inputs": sheet.inputs.len(),
        "models": model_ids,
        "outputs": outputs.len(),
        "personal_subscription": personal,
    })
}

// ---------------------------------------------------------------------------
// Reading a run

/// model-pick counts a dollar as 1,400 won.
const KRW_PER_USD: f64 = 1400.0;

/// KST date of an RFC 3339 time, else today's.
fn kst_date(at: Option<&str>) -> String {
    let kst = chrono::FixedOffset::east_opt(9 * 3600).expect("valid offset");
    at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&kst))
        .unwrap_or_else(|| chrono::Utc::now().with_timezone(&kst))
        .format("%Y-%m-%d")
        .to_string()
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from)
}

/// Studio picture provenance (`asset.source` of `generate_asset`) → the
/// model-pick `models.json` id. Unknown ones come back as the cloud model id
/// without its vendor (`vendor/name` → `name`) or the ComfyUI workflow, so a
/// missing register line names itself — the request's `models` maps the rest.
pub fn model_of(source: &Value) -> Option<String> {
    let provider = s(source, "provider");
    let model = s(source, "model");
    let workflow = s(source, "workflow");
    let id = match (provider.as_deref(), model.as_deref(), workflow.as_deref()) {
        (Some("codex"), _, _) => "codex-imagegen".to_string(),
        (_, Some(m), _) => {
            let name = m.rsplit('/').next().unwrap_or(m);
            match name {
                "gemini-nano-banana-2.1" => "nano-banana-2.1".to_string(),
                n => n.to_string(),
            }
        }
        (_, None, Some(w)) => {
            let w = w.to_ascii_lowercase();
            if w.contains("lightning") && w.contains("qwen") {
                "qwen-image-2512-lightning".into()
            } else if w.starts_with("qwen-image-21") || w.starts_with("qwen-image-2.1") {
                "qwen-image-2.1".into()
            } else if w.starts_with("ideogram") {
                "ideogram-4".into()
            } else if w.starts_with("ming-image") {
                "ming-image".into()
            } else {
                w
            }
        }
        // comfyui with no workflow named is the generator's default picture
        (Some("comfyui") | None, None, None) => "qwen-image-2.1".into(),
        _ => return None,
    };
    Some(id)
}

/// `gen[2].inner[0].make` → `[("gen", 2), ("gen[2].inner", 0)]`: each
/// `each` node key and the item index under it.
fn each_path(key: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(open) = key[at..].find('[').map(|i| i + at) {
        let Some(close) = key[open..].find(']').map(|i| i + open) else {
            break;
        };
        if let Ok(n) = key[open + 1..close].parse() {
            out.push((key[..open].to_string(), n));
        }
        at = close + 1;
    }
    out
}

/// Short words for a binding value: a string, a number, or an object's
/// `name` · `label` · `title` · `style` · `id`. Results (objects with `ok`)
/// are none.
fn label_of(v: &Value) -> Option<String> {
    let l = match v {
        Value::String(t) if !t.is_empty() && t.chars().count() <= 60 => Some(t.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Object(o) if !o.contains_key("ok") => ["name", "label", "title", "style", "id"]
            .iter()
            .find_map(|k| o.get(*k).and_then(Value::as_str).map(String::from)),
        _ => None,
    };
    // model-pick reads `a · b` in an input's kind as group · branch — a
    // single name keeps its dot as a slash
    l.map(|l| l.replace(" · ", " / "))
}

/// Every string inside a value.
fn strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(t) => out.push(t.clone()),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
        Value::Object(o) => o.values().for_each(|x| strings(x, out)),
        _ => {}
    }
}

/// Which result a score or a pick points at: a result's file anywhere in it
/// (the safe way), else its `index` into the results in each order.
fn target(v: &Value, results: &[SheetResult], index: Option<u64>) -> Option<usize> {
    let mut ss = Vec::new();
    strings(v, &mut ss);
    results
        .iter()
        .position(|r| {
            r.file
                .as_ref()
                .is_some_and(|f| ss.iter().any(|x| Path::new(x) == f))
        })
        .or_else(|| index.map(|i| i as usize).filter(|i| *i < results.len()))
}

/// Read a run record (`runs/<flow>/<run>/run.json`, studio_flows
/// `RunRecord`) into a [`Sheet`]. Files in the sheet are relative to the
/// project root (pictures are project materials).
///
/// The run is read for what a round needs, not node by node:
/// - results — every finished node whose output is a `generate_asset`
///   result (`asset` + `path`); the model is its `asset.source`;
/// - inputs — results with the same prompt are one input; its label is what
///   their `each` bindings share (the condition), e.g. `연필`; the material
///   a picture was drawn from (`asset.source.from`) is that input's `refs`;
/// - scores — a node output (or a `model_once` output's `output`) with
///   `scores: [{index | file, score, why}]`; the judge is that node's `who`;
/// - picks — the run's `answers` (`{index, item}` · `{indexes, items}`).
///
/// `index` is a position in the results in each order (the key's `[n]`s);
/// a file path in the score or pick wins over it.
pub fn sheet_from_run(run: &Value) -> Result<Sheet, String> {
    let flow = s(run, "flow").ok_or("run.json 에 flow 가 없다")?;
    let run_id = s(run, "id").ok_or("run.json 에 id 가 없다")?;
    let flow_doc = run.get("flow_doc").unwrap_or(&Value::Null);
    let want = run
        .get("want")
        .or_else(|| flow_doc.get("want"))
        .unwrap_or(&Value::Null);
    let want_line = want
        .as_str()
        .map(String::from)
        .or_else(|| s(want, "text"))
        .filter(|w| !w.trim().is_empty());
    let flow_name = s(flow_doc, "name")
        .or_else(|| s(flow_doc, "title"))
        .unwrap_or_else(|| flow.clone());
    let nodes: Vec<&Value> = run["nodes"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let by_key: BTreeMap<String, &Value> = nodes
        .iter()
        .filter_map(|n| Some((s(n, "key")?, *n)))
        .collect();

    // results, in each order
    struct Found {
        order: Vec<usize>,
        prompt: String,
        labels: Vec<String>,
        from: Option<String>,
        result: SheetResult,
    }
    let mut found: Vec<Found> = Vec::new();
    for n in &nodes {
        let out = &n["output"];
        if out["ok"] != json!(true) || s(n, "status").as_deref().is_some_and(|st| st != "done") {
            continue;
        }
        let (Some(path), Some(asset)) = (s(out, "path"), out.get("asset")) else {
            continue;
        };
        if s(asset, "kind").as_deref().is_some_and(|k| k != "image") {
            continue;
        }
        let source = asset.get("source").unwrap_or(&Value::Null);
        let Some(model) = model_of(source) else {
            continue;
        };
        let key = s(n, "key").unwrap_or_default();
        let path_ = each_path(&key);
        let mut labels = Vec::new();
        for (each_key, i) in &path_ {
            let Some(item) = by_key.get(each_key).and_then(|e| e["output"].get(*i)) else {
                continue;
            };
            if let Some(o) = item.as_object() {
                for (k, v) in o {
                    if k != "index" {
                        labels.extend(label_of(v));
                    }
                }
            }
        }
        let prompt = s(&n["input"], "prompt")
            .or_else(|| s(source, "prompt"))
            .unwrap_or_default();
        let ms = n["ms"].as_f64();
        found.push(Found {
            order: path_.iter().map(|(_, i)| *i).collect(),
            prompt,
            labels,
            from: s(source, "from"),
            result: SheetResult {
                input: String::new(),
                model,
                file: Some(PathBuf::from(path)),
                secs: ms.filter(|m| *m > 0.0).map(|m| m / 1000.0),
                cost_krw: n["cost_usd"]
                    .as_f64()
                    .map(|c| (c * KRW_PER_USD * 10.0).round() / 10.0),
                sent: n.get("input").filter(|v| v.is_object()).cloned(),
                ..Default::default()
            },
        });
    }
    found.sort_by(|a, b| a.order.cmp(&b.order));

    // material id → project path, from any listing or generate result
    let mut materials: BTreeMap<String, String> = BTreeMap::new();
    for n in &nodes {
        let out = &n["output"];
        for a in out["assets"].as_array().into_iter().flatten() {
            if let (Some(id), Some(file)) = (s(a, "id"), s(a, "file")) {
                materials.insert(id, format!("assets/{file}"));
            }
        }
        if let (Some(id), Some(path)) = (out.get("asset").and_then(|a| s(a, "id")), s(out, "path"))
        {
            materials.entry(id).or_insert(path);
        }
    }

    // inputs: one per prompt, labelled by what its results' bindings share
    let mut inputs: Vec<SheetInput> = Vec::new();
    let mut prompts: Vec<String> = Vec::new();
    for f in &found {
        if !prompts.contains(&f.prompt) {
            prompts.push(f.prompt.clone());
        }
    }
    for (i, p) in prompts.iter().enumerate() {
        let same: Vec<&Found> = found.iter().filter(|f| &f.prompt == p).collect();
        let mut shared: Vec<String> = Vec::new();
        for l in &same[0].labels {
            if same.iter().all(|f| f.labels.contains(l))
                && !same.iter().any(|f| &f.result.model == l)
                && !shared.contains(l)
            {
                shared.push(l.clone());
            }
        }
        let kind = if shared.is_empty() {
            format!("넣은 것 {}", i + 1)
        } else {
            shared.join(" · ")
        };
        let mut refs: Vec<(PathBuf, String)> = Vec::new();
        for id in same.iter().filter_map(|f| f.from.as_ref()) {
            if let Some(path) = materials.get(id) {
                if !refs.iter().any(|(r, _)| r == Path::new(path)) {
                    refs.push((PathBuf::from(path), "넣은 참고 그림".into()));
                }
            }
        }
        inputs.push(SheetInput {
            id: format!("i{}", i + 1),
            kind,
            text: p.clone(),
            prompt: None,
            refs,
        });
    }
    let mut results: Vec<SheetResult> = found
        .into_iter()
        .map(|f| {
            let i = prompts.iter().position(|p| p == &f.prompt).unwrap_or(0);
            SheetResult {
                input: format!("i{}", i + 1),
                ..f.result
            }
        })
        .collect();

    // scores
    let mut judge = None;
    for n in &nodes {
        let out = &n["output"];
        let Some(scores) = out
            .get("scores")
            .or_else(|| out.pointer("/output/scores"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for sc in scores {
            let Some(score) = sc["score"].as_f64() else {
                continue;
            };
            if let Some(t) = target(sc, &results, sc["index"].as_u64()) {
                results[t].score = Some(score);
                results[t].why = s(sc, "why");
                judge = judge.or_else(|| s(n, "who"));
            }
        }
    }

    // picks — the answers to human cards
    let mut pick_notes = Vec::new();
    if let Some(answers) = run["answers"].as_object() {
        for a in answers.values() {
            let mut picks: Vec<(Value, Option<u64>)> = Vec::new();
            if a.get("index").is_some() || a.get("item").is_some() {
                picks.push((
                    a.get("item").cloned().unwrap_or(Value::Null),
                    a["index"].as_u64(),
                ));
            }
            if let Some(ix) = a["indexes"].as_array() {
                let items = a["items"].as_array();
                for (k, i) in ix.iter().enumerate() {
                    let item = items.and_then(|v| v.get(k)).cloned().unwrap_or(Value::Null);
                    picks.push((item, i.as_u64()));
                }
            }
            if let Some(n) = s(a, "note").filter(|n| !n.trim().is_empty()) {
                pick_notes.push(n);
            }
            for (item, index) in picks {
                if let Some(t) = target(&item, &results, index) {
                    results[t].picked = true;
                }
            }
        }
    }

    // refs — run inputs that name a picture in the project
    let refs = run["inputs"]
        .as_object()
        .map(|o| {
            o.iter()
                .flat_map(|(k, v)| {
                    let mut ss = Vec::new();
                    strings(v, &mut ss);
                    ss.into_iter().map(move |x| (x, k.clone()))
                })
                .filter(|(x, _)| {
                    let e = ext_of(Path::new(x));
                    [".png", ".jpg", ".jpeg", ".webp"].contains(&e.as_str()) && !x.contains("..")
                })
                .map(|(x, k)| (PathBuf::from(x), k))
                .collect()
        })
        .unwrap_or_default();

    let mut notes = Vec::new();
    if let Some(l) = s(run, "label") {
        notes.push(format!("이 실행에서 바꾼 것: {l}"));
    }
    if let Some(w) = want
        .get("good")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    {
        notes.push(format!(
            "좋은 예: {}",
            w.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }
    if let Some(w) = want
        .get("bad")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
    {
        notes.push(format!(
            "나쁜 예: {}",
            w.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }

    let conditions = inputs
        .iter()
        .map(|i| i.kind.clone())
        .filter(|k| !k.starts_with("넣은 것"))
        .take(8)
        .collect();
    Ok(Sheet {
        flow,
        flow_name,
        run: run_id,
        date: kst_date(run["started_at"].as_str()),
        want: want_line,
        // a picture drawn from a reference is Image-to-Image in model-pick
        task: s(flow_doc, "task").or_else(|| {
            inputs
                .iter()
                .any(|i| !i.refs.is_empty())
                .then(|| "text+image-to-image".to_string())
        }),
        conditions,
        refs,
        inputs,
        results,
        judge,
        pick_notes,
        notes,
    })
}

/// A round id tail from a run id: `20261011-163000-ab12` → `163000-ab12`
/// (the round id already starts with the date).
fn short_run(run: &str) -> String {
    match run.split_once('-') {
        Some((d, rest)) if d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()) => {
            rest.to_string()
        }
        _ => run.to_string(),
    }
}

/// The `export_round` op: read the run, write the round, optionally dry-run
/// model-pick's publish.
pub async fn export_round(root: &Path, req: ExportRequest) -> Value {
    if !is_slug(&req.flow) || !is_slug(&req.run) {
        return fail("flow · run 은 영문 · 숫자 · - · _ 만");
    }
    let run_file = root
        .join(RUNS_DIR)
        .join(&req.flow)
        .join(&req.run)
        .join("run.json");
    let run = match read_json(&run_file) {
        Ok(r) => r,
        Err(e) => return fail(format!("실행 기록을 못 읽었다 — {e}")),
    };
    if s(&run, "status")
        .as_deref()
        .is_some_and(|st| st == "running")
    {
        return fail("아직 도는 실행이다 — 끝나거나 고르기에서 멈춘 뒤 내보낸다");
    }
    let sheet = match sheet_from_run(&run) {
        Ok(s) => s,
        Err(e) => return fail(format!("실행 기록을 못 읽었다 — {e}")),
    };
    let mp = model_pick_dir(&req);
    if !mp.join("tool/publish.sh").is_file() {
        return fail(format!(
            "model-pick 체크아웃이 아니다 — {} (model_pick 또는 $MODEL_PICK_DIR)",
            mp.display()
        ));
    }
    let mut out = {
        let (sheet, root, req, mp) = (sheet, root.to_path_buf(), req.clone(), mp.clone());
        match tokio::task::spawn_blocking(move || write_round(&sheet, &root, &req, &mp)).await {
            Ok(v) => v,
            Err(e) => return fail(e.to_string()),
        }
    };
    if out["ok"] != json!(true) {
        return out;
    }
    if req.check {
        out["dry_run"] = dry_run(&mp).await;
    }
    out["next"] = json!(
        "model-pick repo 에서 work.sh start → rounds/<판> 커밋 → tool/publish.sh(내부망 · Vault) → land. 집 안 판이라 dev(model-pick.home.tinysolver.me)에만 뜬다"
    );
    out
}

/// `tool/publish.sh --dry-run` in the checkout: builds every round, buckets
/// untouched. `{ ok, tail }`.
async fn dry_run(mp: &Path) -> Value {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("tool/publish.sh")
        .arg("--dry-run")
        .current_dir(mp)
        .kill_on_drop(true);
    match tokio::time::timeout(DRY_RUN_TIMEOUT, cmd.output()).await {
        Err(_) => json!({ "ok": false, "tail": "publish.sh --dry-run 이 5분 안에 안 끝났다" }),
        Ok(Err(e)) => json!({ "ok": false, "tail": e.to_string() }),
        Ok(Ok(o)) => {
            let all = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            let tail: Vec<&str> = all
                .lines()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            json!({ "ok": o.status.success(), "tail": tail.join("\n") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_pick(dir: &Path) {
        std::fs::create_dir_all(dir.join("tool")).unwrap();
        std::fs::write(dir.join("tool/publish.sh"), "echo ok\n").unwrap();
        std::fs::write(
            dir.join("tasks.json"),
            r#"{"tasks":[{"id":"text-to-image"},{"id":"text+image-to-image"},{"id":"text-to-text"}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("models.json"),
            r#"{"models":[{"id":"qwen-image-2.1","tasks":["text-to-image","text+image-to-image"]},
                {"id":"codex-imagegen","tasks":["text-to-image","text+image-to-image"]},
                {"id":"claude-opus","tasks":["text-to-text"]}]}"#,
        )
        .unwrap();
    }

    const RUN: &str = "20261011-163000-ab12";

    fn gen(key: &str, file: &str, prompt: &str, mut source: Value, ms: u64) -> Value {
        source["from"] = json!(if prompt == "crayon" {
            "ref-crayon"
        } else {
            "ref-pencil"
        });
        json!({ "key": key, "node": "make", "kind": "op", "status": "done", "who": "op:generate_asset",
            "input": { "kind": "image", "prompt": prompt }, "ms": ms, "started_at": "2026-10-11T16:00:01Z",
            "output": { "ok": true, "path": format!("assets/{file}"),
                "asset": { "id": "x", "file": file, "kind": "image", "source": source } } })
    }

    fn project(dir: &Path) -> PathBuf {
        let run_dir = dir.join("runs/style-find").join(RUN);
        let img = dir.join("assets/generated/images");
        std::fs::create_dir_all(&run_dir).unwrap();
        std::fs::create_dir_all(&img).unwrap();
        for f in ["a-q.png", "a-c.png", "b-q.png", "b-c.png"] {
            std::fs::write(img.join(f), b"img").unwrap();
        }
        std::fs::write(dir.join("assets/ref.jpg"), b"img").unwrap();
        std::fs::create_dir_all(dir.join("assets/refs")).unwrap();
        std::fs::write(dir.join("assets/refs/crayon.jpg"), b"img").unwrap();
        let q = json!({ "provider": "comfyui", "workflow": "qwen-image-21-rgba" });
        let c = json!({ "provider": "codex" });
        let item = |cond: &str, model: &str, i: u64| json!({ "cond": { "name": cond }, "card": { "style": cond, "model": model }, "model": model, "index": i, "make": { "ok": true } });
        let run = json!({
            "schema": 1, "id": RUN, "flow": "style-find", "status": "done",
            "want": { "text": "꿀꿀이 그림체를 찾는다", "good": ["손맛"], "bad": [] },
            "inputs": { "ref": "assets/ref.jpg", "n": 2 },
            "flow_doc": { "name": "그림체 찾기" },
            "label": "채점 기준에 손맛 추가",
            "started_at": "2026-10-11T16:00:00Z", "ms": 90000, "cost_usd": 0.02,
            "nodes": [
                { "key": "materials", "node": "materials", "kind": "op", "status": "done", "started_at": "2026-10-11T16:00:00Z",
                  "output": { "ok": true, "assets": [{ "id": "ref-crayon", "file": "refs/crayon.jpg" }] } },
                { "key": "gen", "node": "gen", "kind": "each", "status": "done", "started_at": "2026-10-11T16:00:00Z",
                  "output": [item("연필", "qwen", 0), item("연필", "codex", 1), item("크레용", "qwen", 2), item("크레용", "codex", 3)] },
                // recorded out of order (parallel) — each order comes from the keys
                gen("gen[1].make", "generated/images/a-c.png", "pencil sketch", c.clone(), 40000),
                gen("gen[0].make", "generated/images/a-q.png", "pencil sketch", q.clone(), 3210),
                gen("gen[2].make", "generated/images/b-q.png", "crayon", q, 3000),
                gen("gen[3].make", "generated/images/b-c.png", "crayon", c, 41000),
                { "key": "score", "node": "score", "kind": "model", "status": "done", "who": "claude/sonnet",
                  "started_at": "2026-10-11T16:01:00Z", "cost_usd": 0.01,
                  "output": { "ok": true, "output": { "scores": [
                      { "index": 0, "score": 7, "why": "선이 연필 같다" },
                      { "index": 3, "score": 9, "why": "크레용 질감" }], "best": 3 } } },
                { "key": "pick", "node": "pick", "kind": "human", "status": "done", "who": "human",
                  "started_at": "2026-10-11T16:02:00Z", "output": null }
            ],
            "answers": { "pick": { "index": 0, "item": { "path": "assets/generated/images/b-c.png" }, "note": "결이 좋다" } }
        });
        std::fs::write(
            run_dir.join("run.json"),
            serde_json::to_string(&run).unwrap(),
        )
        .unwrap();
        dir.to_path_buf()
    }

    fn req(mp: &Path) -> ExportRequest {
        ExportRequest {
            flow: "style-find".into(),
            run: RUN.into(),
            model_pick: Some(mp.to_string_lossy().into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn exports_a_run_as_an_internal_round() {
        let t = tempfile::tempdir().unwrap();
        let (root, mp) = (t.path().join("p"), t.path().join("mp"));
        project(&root);
        model_pick(&mp);
        let out = export_round(&root, req(&mp)).await;
        assert_eq!(out["ok"], json!(true), "{out}");
        assert_eq!(out["round"], "2026-10-12-style-find-163000-ab12"); // 16:00Z = next day KST
        let dir = mp.join("rounds/2026-10-12-style-find-163000-ab12");
        let r: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("round.json")).unwrap())
                .unwrap();
        assert_eq!(r["format"], ROUND_FORMAT);
        assert_eq!(r["internal"], true);
        assert!(r["internal_note"].as_str().unwrap().contains(AI_MADE));
        assert!(r["internal_note"].as_str().unwrap().contains("codex"));
        assert!(r["summary"].as_str().unwrap().contains(AI_MADE));
        // a reference picture went in → Image-to-Image
        assert_eq!(r["workflow"]["task"], "text+image-to-image");
        assert_eq!(r["workflow"]["name"], "그림체 찾기");
        assert_eq!(r["workflow"]["desc"], "꿀꿀이 그림체를 찾는다");
        assert_eq!(r["workflow"]["conditions"], json!(["연필", "크레용"]));
        assert_eq!(
            r["inputs"],
            json!([
            { "id": "i1", "kind": "연필", "text": "pencil sketch" },
            { "id": "i2", "kind": "크레용", "text": "crayon",
              "refs": [{ "file": "media/i2-ref-1.jpg", "label": "넣은 참고 그림" }] }])
        );
        assert!(dir.join("media/i2-ref-1.jpg").is_file());
        assert_eq!(r["pick"], "codex-imagegen");
        assert_eq!(r["verdict_by"], "고르기 카드 답(사람)");
        assert_eq!(
            r["verdict"],
            "고르기 카드에서 고른 것: 크레용 × codex-imagegen — 메모: 결이 좋다"
        );
        let outs = r["outputs"].as_array().unwrap();
        assert_eq!(outs.len(), 4);
        // each order: gen[0] qwen · gen[1] codex · …
        assert_eq!(outs[0]["model"], "qwen-image-2.1");
        assert_eq!(outs[0]["file"], "media/i1-qwen-image-2.1.png");
        assert_eq!(outs[0]["secs"], 3.2);
        assert_eq!(outs[0]["checks"]["ai_score"], 7.0);
        assert_eq!(outs[0]["checks"]["picked"], 0);
        assert_eq!(outs[3]["model"], "codex-imagegen");
        assert_eq!(
            outs[3]["checks"]["picked"], 1,
            "the pick's path wins over its index"
        );
        assert_eq!(outs[3]["judge"], "크레용 질감");
        assert!(outs[1]["checks"].get("ai_score").is_none());
        assert_eq!(
            r["refs"][0],
            json!({ "file": "media/ref-1.jpg", "label": "ref" })
        );
        assert!(r["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n.as_str().unwrap().contains("손맛 추가")));
        assert!(r["checks"][0]["desc"]
            .as_str()
            .unwrap()
            .contains("claude/sonnet"));
        assert_eq!(
            r["checks"][0]["scale"], true,
            "a 0-10 score is a number, not pass/fail"
        );
        for o in outs {
            assert!(dir.join(o["file"].as_str().unwrap()).is_file());
        }
    }

    #[tokio::test]
    async fn refuses_a_running_run() {
        let t = tempfile::tempdir().unwrap();
        let (root, mp) = (t.path().join("p"), t.path().join("mp"));
        project(&root);
        model_pick(&mp);
        let f = root.join("runs/style-find").join(RUN).join("run.json");
        let mut run: Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        run["status"] = json!("running");
        std::fs::write(&f, run.to_string()).unwrap();
        assert!(export_round(&root, req(&mp)).await["note"]
            .as_str()
            .unwrap()
            .contains("도는 실행"));
    }

    #[test]
    fn names_studio_pictures_by_model_pick_ids() {
        assert_eq!(
            model_of(&json!({"provider":"codex"})).unwrap(),
            "codex-imagegen"
        );
        assert_eq!(
            model_of(&json!({"provider":"openrouter","model":"google/gemini-nano-banana-2.1"}))
                .unwrap(),
            "nano-banana-2.1"
        );
        assert_eq!(
            model_of(&json!({"provider":"openrouter","model":"openai/gpt-image-2.5-flare"}))
                .unwrap(),
            "gpt-image-2.5-flare"
        );
        assert_eq!(
            model_of(&json!({"provider":"comfyui","workflow":"qwen-image-21-rgba"})).unwrap(),
            "qwen-image-2.1"
        );
        assert_eq!(
            each_path("gen[2].inner[0].make"),
            vec![("gen".into(), 2), ("gen[2].inner".into(), 0)]
        );
        assert_eq!(short_run("20261011-163000-ab12"), "163000-ab12");
        assert_eq!(
            label_of(&json!({ "style": "꿀꿀 연필 · 크레용" })).unwrap(),
            "꿀꿀 연필 / 크레용"
        );
    }

    #[tokio::test]
    async fn stops_on_a_model_missing_from_models_json() {
        let t = tempfile::tempdir().unwrap();
        let (root, mp) = (t.path().join("p"), t.path().join("mp"));
        project(&root);
        model_pick(&mp);
        let mut q = req(&mp);
        q.models
            .insert("codex-imagegen".into(), "no-such-model".into());
        let out = export_round(&root, q).await;
        assert_eq!(out["ok"], json!(false));
        assert!(
            out["note"].as_str().unwrap().contains("models.json"),
            "{out}"
        );
        assert!(
            !mp.join("rounds").exists()
                || std::fs::read_dir(mp.join("rounds"))
                    .unwrap()
                    .next()
                    .is_none()
        );
    }

    #[tokio::test]
    async fn refuses_to_overwrite_unless_asked() {
        let t = tempfile::tempdir().unwrap();
        let (root, mp) = (t.path().join("p"), t.path().join("mp"));
        project(&root);
        model_pick(&mp);
        assert_eq!(export_round(&root, req(&mp)).await["ok"], json!(true));
        assert_eq!(export_round(&root, req(&mp)).await["ok"], json!(false));
        let mut q = req(&mp);
        q.overwrite = true;
        assert_eq!(export_round(&root, q).await["ok"], json!(true));
    }

    #[tokio::test]
    async fn stops_on_a_task_missing_from_tasks_json_and_on_a_task_the_model_cannot_do() {
        let t = tempfile::tempdir().unwrap();
        let (root, mp) = (t.path().join("p"), t.path().join("mp"));
        project(&root);
        model_pick(&mp);
        let mut q = req(&mp);
        q.task = Some("image-to-3d".into());
        assert!(export_round(&root, q).await["note"]
            .as_str()
            .unwrap()
            .contains("tasks.json"));
        let mut q = req(&mp);
        q.task = Some("text-to-text".into());
        assert!(export_round(&root, q).await["note"]
            .as_str()
            .unwrap()
            .contains("못 한다"));
    }

    #[test]
    fn rejects_path_like_ids() {
        assert!(!is_slug("../x"));
        assert!(!is_slug("a/b"));
        assert!(is_slug("style-find_2"));
    }
}
