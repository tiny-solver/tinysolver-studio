//! Cursor ACP client-extension methods.
//!
//! Cursor's CLI (`cursor-agent acp`) sends these as JSON-RPC **requests with
//! ids**, even when https://cursor.com/docs/cli/acp calls some of them
//! notifications. sacp's default for an unregistered method is `-32601 Method
//! not found`, which is what codeg used to send — and what made a live Cursor
//! turn show a red banner on every `Task` spawn / todo update.
//!
//! Blocking methods (`cursor/ask_question`, `cursor/create_plan`) wait for a
//! reply before the agent continues. They reuse the same interactive cards as
//! the Grok bridges ([`crate::acp::question`], [`crate::acp::plan_approval`])
//! so a new agent does not grow a third UI. Fire-and-forget-shaped methods
//! (`cursor/update_todos`, `cursor/task`, `cursor/generate_image`) still need
//! an `accepted` / `completed` / `generated` envelope because the CLI sends a
//! request id; the reply is the documented outcome object, not a silent drop.
//!
//! Adding a new `cursor/…` method: one `#[request(method = …)]` newtype here,
//! one `.on_receive_request` in `connection.rs`, a reply builder in this
//! module. sacp routes on the raw wire method, so the derive string must match
//! Cursor's docs byte-for-byte.

use sacp::JsonRpcRequest;
use serde_json::{json, Value};

use crate::acp::plan_approval::{
    PlanApprovalAnswer, PlanApprovalDecision, MAX_PLAN_MARKDOWN_CHARS,
};
use crate::acp::question::{
    QuestionOption, QuestionOutcome, QuestionSpec, MAX_HEADER_CHARS, MAX_OPTIONS, MAX_QUESTIONS,
    MAX_QUESTION_TEXT_CHARS, MIN_OPTIONS,
};

/// `cursor/ask_question` — blocking. Params `{ toolCallId, title?, questions }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/ask_question", response = Value)]
#[serde(transparent)]
pub struct CursorAskQuestionRequest(pub Value);

/// `cursor/create_plan` — blocking. Params `{ toolCallId, name?, overview?, plan, todos?, … }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/create_plan", response = Value)]
#[serde(transparent)]
pub struct CursorCreatePlanRequest(pub Value);

/// `cursor/update_todos`. Params `{ toolCallId, todos, merge }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/update_todos", response = Value)]
#[serde(transparent)]
pub struct CursorUpdateTodosRequest(pub Value);

/// `cursor/task`. Params `{ toolCallId, description, prompt, subagentType, agentId?, durationMs? }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/task", response = Value)]
#[serde(transparent)]
pub struct CursorTaskRequest(pub Value);

/// `cursor/generate_image`. Params `{ toolCallId, description, filePath?, referenceImagePaths? }`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, JsonRpcRequest)]
#[request(method = "cursor/generate_image", response = Value)]
#[serde(transparent)]
pub struct CursorGenerateImageRequest(pub Value);

/// Cursor's documented `{ outcome: { outcome: <kind>, … } }` envelope.
pub fn cursor_outcome(kind: &str) -> Value {
    json!({ "outcome": { "outcome": kind } })
}

fn cursor_outcome_with(kind: &str, extra: Value) -> Value {
    let mut inner = json!({ "outcome": kind });
    if let (Some(obj), Some(extra_obj)) = (inner.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    json!({ "outcome": inner })
}

/// One Cursor question plus the label → option-id map needed to reply. The
/// card shows labels (same as Grok / pi); Cursor's response wants option ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorAskQuestion {
    pub spec: QuestionSpec,
    /// Cursor's `questions[].id` (the `questionId` we must echo).
    pub cursor_id: String,
    /// `(label, option id)` in wire order, mirroring [`crate::acp::question::PiSelectAsk`].
    pub option_ids: Vec<(String, String)>,
}

/// Parse `cursor/ask_question` params into card specs + the id map for the
/// reply. Cursor's shape is `{ questions: [{ id, prompt, options:[{id,label}],
/// allowMultiple? }] }` — `prompt` not `question`, `allowMultiple` not
/// `multiSelect`. Counts are clamped to codeg's card bounds the same way
/// [`crate::acp::question::parse_grok_ext_questions`] clamps Grok, so
/// `register_question` will not decline the whole ask.
pub fn parse_cursor_ask_questions(params: &Value) -> Result<Vec<CursorAskQuestion>, String> {
    let arr = params
        .get("questions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "cursor/ask_question missing `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("cursor/ask_question has no questions".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        tracing::warn!(
            "[cursor ask] dropping {} question(s) past the max of {MAX_QUESTIONS}",
            arr.len() - MAX_QUESTIONS
        );
    }
    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut out = Vec::with_capacity(arr.len().min(MAX_QUESTIONS));
    for (qi, q) in arr.iter().take(MAX_QUESTIONS).enumerate() {
        let prompt = q
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `prompt`"))?;
        let cursor_id = q
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("q{qi}"));
        let multi_select = q
            .get("allowMultiple")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let opts = q
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if opts.len() > MAX_OPTIONS {
            tracing::warn!(
                "[cursor ask] questions[{qi}] has {} options; truncating to {MAX_OPTIONS}",
                opts.len()
            );
        }
        let mut options = Vec::with_capacity(opts.len().min(MAX_OPTIONS));
        let mut option_ids = Vec::new();
        let mut seen_labels = std::collections::HashSet::new();
        for o in opts {
            if options.len() == MAX_OPTIONS {
                break;
            }
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(label) = label else { continue };
            if !seen_labels.insert(label.to_string()) {
                continue;
            }
            let option_id = o
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(label)
                .to_string();
            let clipped: String = label.chars().take(MAX_QUESTION_TEXT_CHARS).collect();
            options.push(QuestionOption {
                label: clipped.clone(),
                description: String::new(),
            });
            option_ids.push((clipped, option_id));
        }
        if options.len() < MIN_OPTIONS {
            return Err(format!(
                "questions[{qi}] has fewer than {MIN_OPTIONS} usable options"
            ));
        }
        let header: String = title
            .unwrap_or("Cursor")
            .chars()
            .take(MAX_HEADER_CHARS)
            .collect();
        out.push(CursorAskQuestion {
            spec: QuestionSpec {
                id: uuid::Uuid::new_v4().to_string(),
                question: prompt.chars().take(MAX_QUESTION_TEXT_CHARS).collect(),
                header,
                multi_select,
                options,
                is_secret: false,
            },
            cursor_id,
            option_ids,
        });
    }
    Ok(out)
}

/// Map the card's outcome onto Cursor's `CursorAskQuestionResponse`.
pub fn build_cursor_ask_response(parsed: &[CursorAskQuestion], outcome: &QuestionOutcome) -> Value {
    if outcome.declined {
        return cursor_outcome("skipped");
    }
    let mut answers = Vec::new();
    for q in parsed {
        let Some(item) = outcome
            .answers
            .iter()
            .find(|a| a.question == q.spec.question)
        else {
            continue;
        };
        let selected_option_ids: Vec<String> = item
            .selected
            .iter()
            .filter_map(|label| {
                q.option_ids
                    .iter()
                    .find(|(l, _)| l == label)
                    .map(|(_, id)| id.clone())
            })
            .collect();
        answers.push(json!({
            "questionId": q.cursor_id,
            "selectedOptionIds": selected_option_ids,
        }));
    }
    json!({
        "outcome": {
            "outcome": "answered",
            "answers": answers,
        }
    })
}

pub fn cursor_ask_skip_response() -> Value {
    cursor_outcome("skipped")
}

/// Plan markdown + toolCallId for the shared approval card. Cursor puts the
/// body in `plan` (not Grok's `planContent`). Empty plan is valid — same
/// empty-state surface as Grok.
pub fn parse_cursor_create_plan(params: &Value) -> Result<(String, String), String> {
    let obj = params
        .as_object()
        .ok_or_else(|| "cursor/create_plan params is not an object".to_string())?;
    let mut plan: String = obj
        .get("plan")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .chars()
        .take(MAX_PLAN_MARKDOWN_CHARS)
        .collect();
    if plan.is_empty() {
        if let Some(overview) = obj.get("overview").and_then(|v| v.as_str()) {
            plan = overview.chars().take(MAX_PLAN_MARKDOWN_CHARS).collect();
        }
    }
    let tool_call_id = obj
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok((plan, tool_call_id))
}

/// Map the plan-approval card onto Cursor's `CursorCreatePlanResponse`.
/// Approve → `accepted` (unblocks the agent). Request-changes / abandon →
/// `rejected` / `cancelled` so Cursor does not treat a disconnect as a silent
/// go-ahead — same caution as [`crate::acp::plan_approval::grok_exit_plan_disconnect_response`].
pub fn build_cursor_create_plan_response(answer: &PlanApprovalAnswer) -> Value {
    match answer.decision {
        PlanApprovalDecision::Approve => cursor_outcome("accepted"),
        PlanApprovalDecision::RequestChanges => {
            let reason = answer.normalized_feedback();
            if reason.is_empty() {
                cursor_outcome("rejected")
            } else {
                cursor_outcome_with("rejected", json!({ "reason": reason }))
            }
        }
        PlanApprovalDecision::Abandon => cursor_outcome("cancelled"),
    }
}

pub fn cursor_create_plan_disconnect_response() -> Value {
    cursor_outcome("cancelled")
}

/// `cursor/update_todos` — accept the list. Live todo UI is a follow-up; the
/// agent only needs the documented `accepted` outcome to stop retrying.
pub fn build_cursor_update_todos_response() -> Value {
    cursor_outcome("accepted")
}

/// `cursor/task` — Cursor already spawned the subagent; we acknowledge so the
/// parent turn is not left waiting on `-32601`. Echo `agentId` / `durationMs`
/// when the request carried them.
pub fn build_cursor_task_response(params: &Value) -> Value {
    let mut extra = serde_json::Map::new();
    if let Some(id) = params.get("agentId").and_then(|v| v.as_str()) {
        extra.insert("agentId".into(), json!(id));
    }
    if let Some(ms) = params.get("durationMs").and_then(|v| v.as_u64()) {
        extra.insert("durationMs".into(), json!(ms));
    }
    if extra.is_empty() {
        cursor_outcome("completed")
    } else {
        cursor_outcome_with("completed", Value::Object(extra))
    }
}

/// `cursor/generate_image` — no image renderer yet. If Cursor already wrote a
/// file, acknowledge the path; otherwise reject so the agent does not hang.
pub fn build_cursor_generate_image_response(params: &Value) -> Value {
    match params.get("filePath").and_then(|v| v.as_str()).map(str::trim) {
        Some(path) if !path.is_empty() => {
            cursor_outcome_with("generated", json!({ "filePath": path }))
        }
        _ => cursor_outcome_with(
            "rejected",
            json!({ "reason": "image display is not implemented" }),
        ),
    }
}

/// Top-level param keys only — never the prompt / plan body.
pub fn param_keys(params: &Value) -> Vec<&str> {
    params
        .as_object()
        .map(|o| o.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_types_match_cursor_docs_methods() {
        assert!(CursorAskQuestionRequest::matches_method("cursor/ask_question"));
        assert!(CursorCreatePlanRequest::matches_method("cursor/create_plan"));
        assert!(CursorUpdateTodosRequest::matches_method("cursor/update_todos"));
        assert!(CursorTaskRequest::matches_method("cursor/task"));
        assert!(CursorGenerateImageRequest::matches_method(
            "cursor/generate_image"
        ));
        assert!(!CursorTaskRequest::matches_method("session/prompt"));
        assert!(!CursorTaskRequest::matches_method("_x.ai/ask_user_question"));
    }

    #[test]
    fn parse_ask_reads_prompt_and_option_ids() {
        let parsed = parse_cursor_ask_questions(&json!({
            "toolCallId": "call_123",
            "title": "Need input",
            "questions": [{
                "id": "q1",
                "prompt": "Which mode should I use?",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ],
                "allowMultiple": false
            }]
        }))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].cursor_id, "q1");
        assert_eq!(parsed[0].spec.question, "Which mode should I use?");
        assert!(!parsed[0].spec.multi_select);
        assert_eq!(parsed[0].option_ids.len(), 2);
        assert_eq!(parsed[0].option_ids[0], ("Agent".into(), "agent".into()));
    }

    #[test]
    fn parse_ask_rejects_empty_or_short_options() {
        assert!(parse_cursor_ask_questions(&json!({ "questions": [] })).is_err());
        assert!(parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Only one?",
                "options": [{ "id": "a", "label": "A" }]
            }]
        }))
        .is_err());
    }

    #[test]
    fn build_ask_response_maps_labels_to_option_ids() {
        let parsed = parse_cursor_ask_questions(&json!({
            "questions": [{
                "id": "q1",
                "prompt": "Pick",
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        }))
        .unwrap();
        let outcome = QuestionOutcome {
            answers: vec![crate::acp::question::QuestionAnsweredItem {
                question: "Pick".into(),
                header: "Cursor".into(),
                multi_select: false,
                selected: vec!["Plan".into()],
            }],
            declined: false,
        };
        let v = build_cursor_ask_response(&parsed, &outcome);
        assert_eq!(v["outcome"]["outcome"], "answered");
        assert_eq!(v["outcome"]["answers"][0]["questionId"], "q1");
        assert_eq!(v["outcome"]["answers"][0]["selectedOptionIds"][0], "plan");
    }

    #[test]
    fn declined_ask_is_skipped() {
        let v = build_cursor_ask_response(
            &[],
            &QuestionOutcome {
                answers: Vec::new(),
                declined: true,
            },
        );
        assert_eq!(v["outcome"]["outcome"], "skipped");
    }

    #[test]
    fn parse_create_plan_reads_plan_not_plan_content() {
        let (plan, tc) = parse_cursor_create_plan(&json!({
            "toolCallId": "call_124",
            "name": "Refactor",
            "plan": "1. Inspect\n2. Update",
        }))
        .unwrap();
        assert_eq!(plan, "1. Inspect\n2. Update");
        assert_eq!(tc, "call_124");
    }

    #[test]
    fn create_plan_decisions_match_cursor_outcomes() {
        let accept = PlanApprovalAnswer {
            decision: PlanApprovalDecision::Approve,
            feedback: None,
        };
        assert_eq!(
            build_cursor_create_plan_response(&accept)["outcome"]["outcome"],
            "accepted"
        );
        let reject = PlanApprovalAnswer {
            decision: PlanApprovalDecision::RequestChanges,
            feedback: Some("use SSE".into()),
        };
        let v = build_cursor_create_plan_response(&reject);
        assert_eq!(v["outcome"]["outcome"], "rejected");
        assert_eq!(v["outcome"]["reason"], "use SSE");
        let cancel = PlanApprovalAnswer {
            decision: PlanApprovalDecision::Abandon,
            feedback: None,
        };
        assert_eq!(
            build_cursor_create_plan_response(&cancel)["outcome"]["outcome"],
            "cancelled"
        );
        assert_eq!(
            cursor_create_plan_disconnect_response()["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn task_echoes_agent_id() {
        let v = build_cursor_task_response(&json!({
            "toolCallId": "call_126",
            "description": "Explore",
            "agentId": "abc-1",
            "durationMs": 12
        }));
        assert_eq!(v["outcome"]["outcome"], "completed");
        assert_eq!(v["outcome"]["agentId"], "abc-1");
        assert_eq!(v["outcome"]["durationMs"], 12);
    }

    #[test]
    fn generate_image_generated_when_path_present() {
        let v = build_cursor_generate_image_response(&json!({
            "filePath": "/tmp/icon.png"
        }));
        assert_eq!(v["outcome"]["outcome"], "generated");
        assert_eq!(v["outcome"]["filePath"], "/tmp/icon.png");
        let rejected = build_cursor_generate_image_response(&json!({}));
        assert_eq!(rejected["outcome"]["outcome"], "rejected");
    }

    #[test]
    fn update_todos_accepted() {
        assert_eq!(
            build_cursor_update_todos_response()["outcome"]["outcome"],
            "accepted"
        );
    }
}
