//! Automation CRUD + cron scheduling math. Mode-agnostic: every fn takes a plain
//! `&DatabaseConnection` so both the Tauri command and the Axum handler share it.
//! `config` is stored as an opaque JSON string and replayed wholesale at fire.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set,
};

use crate::db::entities::automation::TriggerKind;
use crate::db::entities::{automation, automation_run};
use crate::db::error::DbError;
use crate::models::{
    AutomationConfig, AutomationDraft, AutomationInfo, AutomationRunInfo, AutomationRunStatus,
};

fn to_info(m: automation::Model) -> AutomationInfo {
    AutomationInfo {
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        trigger_kind: m.trigger_kind,
        cron: m.cron,
        timezone: m.timezone,
        next_run_at: m.next_run_at,
        agent_type: m.agent_type,
        root_folder_id: m.root_folder_id,
        isolation: m.isolation,
        branch: m.branch,
        is_remote_branch: m.is_remote_branch,
        config: serde_json::from_str(&m.config).unwrap_or(serde_json::Value::Null),
        last_run_at: m.last_run_at,
        last_run_status: m.last_run_status,
        last_run_conversation_id: m.last_run_conversation_id,
        unseen_failures: m.unseen_failures,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

fn run_to_info(m: automation_run::Model) -> AutomationRunInfo {
    AutomationRunInfo {
        id: m.id,
        automation_id: m.automation_id,
        status: m.status,
        trigger: m.trigger,
        scheduled_for: m.scheduled_for,
        started_at: m.started_at,
        ended_at: m.ended_at,
        conversation_id: m.conversation_id,
        worktree_folder_id: m.worktree_folder_id,
        stop_reason: m.stop_reason,
        error: m.error,
        summary: m.summary,
        created_at: m.created_at,
    }
}

// ── cron math ──────────────────────────────────────────────────────────────

/// Normalize a user-supplied 5-field cron (`min hour dom mon dow`) to the
/// 6-field form (`sec min hour dom mon dow`) the `cron` crate requires, by
/// prepending a zero-seconds field. 6/7-field expressions pass through.
fn normalize_cron(expr: &str) -> Result<String, DbError> {
    let trimmed = expr.trim();
    match trimmed.split_whitespace().count() {
        5 => Ok(format!("0 {trimmed}")),
        6 | 7 => Ok(trimmed.to_string()),
        n => Err(DbError::Validation(format!(
            "cron must have 5 fields (min hour dom mon dow), got {n}"
        ))),
    }
}

/// Next fire instant (UTC) of a 5-field cron evaluated in `timezone`, strictly
/// after `after`. `None` when the schedule has no future occurrence. This is the
/// single source of truth shared by create/update, the scheduler, and the
/// editor's "next run" preview — so preview and actual fire can never diverge.
pub fn compute_next_run(
    cron_expr: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    let normalized = normalize_cron(cron_expr)?;
    let schedule = Schedule::from_str(&normalized)
        .map_err(|e| DbError::Validation(format!("invalid cron '{cron_expr}': {e}")))?;
    let tz: Tz = timezone
        .parse()
        .map_err(|_| DbError::Validation(format!("invalid timezone '{timezone}'")))?;
    let after_tz = after.with_timezone(&tz);
    let next = schedule.after(&after_tz).next();
    Ok(next.map(|dt| dt.with_timezone(&Utc)))
}

fn validate_draft(draft: &AutomationDraft) -> Result<(), DbError> {
    if draft.name.trim().is_empty() {
        return Err(DbError::Validation("name is required".into()));
    }
    let cfg: AutomationConfig = serde_json::from_value(draft.config.clone()).unwrap_or_default();
    if cfg.display_text.trim().is_empty() && cfg.prompt_blocks.is_empty() {
        return Err(DbError::Validation("prompt is required".into()));
    }
    if draft.trigger_kind == TriggerKind::Schedule {
        let cron = draft.cron.as_deref().unwrap_or("").trim();
        if cron.is_empty() {
            return Err(DbError::Validation(
                "cron is required for scheduled automations".into(),
            ));
        }
        // Parses cron + timezone (and surfaces an error before we ever store it).
        compute_next_run(cron, &draft.timezone, Utc::now())?;
    }
    Ok(())
}

/// The `next_run_at` to persist for a draft: only scheduled + enabled automations
/// have one. Manual or disabled automations store `None` (scheduler skips them).
fn next_run_for(
    draft: &AutomationDraft,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    if !draft.enabled || draft.trigger_kind != TriggerKind::Schedule {
        return Ok(None);
    }
    compute_next_run(draft.cron.as_deref().unwrap_or(""), &draft.timezone, now)
}

// ── CRUD ───────────────────────────────────────────────────────────────────

async fn find_active(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<automation::Model, DbError> {
    let row = automation::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation {id}")))?;
    if row.deleted_at.is_some() {
        return Err(DbError::NotFound(format!("automation {id}")));
    }
    Ok(row)
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<AutomationInfo>, DbError> {
    let rows = automation::Entity::find()
        .filter(automation::Column::DeletedAt.is_null())
        .order_by_desc(automation::Column::UpdatedAt)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(to_info).collect())
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<AutomationInfo, DbError> {
    Ok(to_info(find_active(conn, id).await?))
}

pub async fn list_runs(
    conn: &DatabaseConnection,
    automation_id: i32,
    limit: u64,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    let rows = automation_run::Entity::find()
        .filter(automation_run::Column::AutomationId.eq(automation_id))
        .order_by_desc(automation_run::Column::CreatedAt)
        .limit(limit)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(run_to_info).collect())
}

pub async fn create(
    conn: &DatabaseConnection,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    validate_draft(&draft)?;
    let now = Utc::now();
    let next_run_at = next_run_for(&draft, now)?;
    let config_str = serde_json::to_string(&draft.config)
        .map_err(|e| DbError::Validation(format!("config not serializable: {e}")))?;

    let active = automation::ActiveModel {
        id: NotSet,
        name: Set(draft.name.trim().to_string()),
        enabled: Set(draft.enabled),
        trigger_kind: Set(draft.trigger_kind),
        cron: Set(draft.cron),
        timezone: Set(draft.timezone),
        next_run_at: Set(next_run_at),
        agent_type: Set(draft.agent_type),
        root_folder_id: Set(draft.root_folder_id),
        isolation: Set(draft.isolation),
        branch: Set(draft.branch),
        is_remote_branch: Set(draft.is_remote_branch),
        config: Set(config_str),
        last_run_at: Set(None),
        last_run_status: Set(None),
        last_run_conversation_id: Set(None),
        unseen_failures: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
    };
    Ok(to_info(active.insert(conn).await?))
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    validate_draft(&draft)?;
    let row = find_active(conn, id).await?;
    let now = Utc::now();
    let next_run_at = next_run_for(&draft, now)?;
    let config_str = serde_json::to_string(&draft.config)
        .map_err(|e| DbError::Validation(format!("config not serializable: {e}")))?;

    let mut active = row.into_active_model();
    active.name = Set(draft.name.trim().to_string());
    active.enabled = Set(draft.enabled);
    active.trigger_kind = Set(draft.trigger_kind);
    active.cron = Set(draft.cron);
    active.timezone = Set(draft.timezone);
    active.next_run_at = Set(next_run_at);
    active.agent_type = Set(draft.agent_type);
    active.root_folder_id = Set(draft.root_folder_id);
    active.isolation = Set(draft.isolation);
    active.branch = Set(draft.branch);
    active.is_remote_branch = Set(draft.is_remote_branch);
    active.config = Set(config_str);
    active.updated_at = Set(now);
    Ok(to_info(active.update(conn).await?))
}

pub async fn set_enabled(
    conn: &DatabaseConnection,
    id: i32,
    enabled: bool,
) -> Result<AutomationInfo, DbError> {
    let row = find_active(conn, id).await?;
    let now = Utc::now();
    let next_run_at = if enabled && row.trigger_kind == TriggerKind::Schedule {
        compute_next_run(row.cron.as_deref().unwrap_or(""), &row.timezone, now)?
    } else {
        None
    };
    let mut active = row.into_active_model();
    active.enabled = Set(enabled);
    active.next_run_at = Set(next_run_at);
    active.updated_at = Set(now);
    Ok(to_info(active.update(conn).await?))
}

/// Soft-delete: hide from the list, stop scheduling. Run history is retained.
pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    let row = find_active(conn, id).await?;
    let mut active = row.into_active_model();
    active.deleted_at = Set(Some(Utc::now()));
    active.enabled = Set(false);
    active.next_run_at = Set(None);
    active.update(conn).await?;
    Ok(())
}

/// Clear all unseen-failure badges (called when the user opens the view).
pub async fn mark_all_seen(conn: &DatabaseConnection) -> Result<(), DbError> {
    automation::Entity::update_many()
        .col_expr(automation::Column::UnseenFailures, Expr::value(0))
        .filter(automation::Column::UnseenFailures.gt(0))
        .exec(conn)
        .await?;
    Ok(())
}

// ── run lifecycle ────────────────────────────────────────────────────────────

fn run_status_str(s: &AutomationRunStatus) -> &'static str {
    match s {
        AutomationRunStatus::Running => "running",
        AutomationRunStatus::Succeeded => "succeeded",
        AutomationRunStatus::Failed => "failed",
        AutomationRunStatus::Cancelled => "cancelled",
        AutomationRunStatus::Skipped => "skipped",
    }
}

/// True if the automation already has a run in flight (overlap guard).
pub async fn has_active_run(
    conn: &DatabaseConnection,
    automation_id: i32,
) -> Result<bool, DbError> {
    let count = automation_run::Entity::find()
        .filter(automation_run::Column::AutomationId.eq(automation_id))
        .filter(automation_run::Column::Status.eq(AutomationRunStatus::Running))
        .count(conn)
        .await?;
    Ok(count > 0)
}

/// Insert a fresh `running` run row at launch.
pub async fn start_run(
    conn: &DatabaseConnection,
    automation_id: i32,
    trigger: &str,
    scheduled_for: Option<DateTime<Utc>>,
) -> Result<AutomationRunInfo, DbError> {
    let now = Utc::now();
    let active = automation_run::ActiveModel {
        id: NotSet,
        automation_id: Set(automation_id),
        status: Set(AutomationRunStatus::Running),
        trigger: Set(trigger.to_string()),
        scheduled_for: Set(scheduled_for),
        started_at: Set(Some(now)),
        ended_at: Set(None),
        conversation_id: Set(None),
        connection_id: Set(None),
        worktree_folder_id: Set(None),
        stop_reason: Set(None),
        error: Set(None),
        summary: Set(None),
        created_at: Set(now),
    };
    let run = active.insert(conn).await?;
    // Reflect the in-flight state on the parent so the list view shows "running"
    // (settle_run overwrites this with the terminal outcome).
    if let Some(auto) = automation::Entity::find_by_id(automation_id).one(conn).await? {
        let mut am = auto.into_active_model();
        am.last_run_status = Set(Some("running".to_string()));
        am.last_run_at = Set(Some(now));
        let _ = am.update(conn).await;
    }
    Ok(run_to_info(run))
}

/// Record a fire suppressed because a prior run was still active (overlap skip).
pub async fn record_skipped_run(
    conn: &DatabaseConnection,
    automation_id: i32,
    trigger: &str,
    scheduled_for: Option<DateTime<Utc>>,
) -> Result<AutomationRunInfo, DbError> {
    let now = Utc::now();
    let active = automation_run::ActiveModel {
        id: NotSet,
        automation_id: Set(automation_id),
        status: Set(AutomationRunStatus::Skipped),
        trigger: Set(trigger.to_string()),
        scheduled_for: Set(scheduled_for),
        started_at: Set(None),
        ended_at: Set(Some(now)),
        conversation_id: Set(None),
        connection_id: Set(None),
        worktree_folder_id: Set(None),
        stop_reason: Set(None),
        error: Set(Some("previous run still active".to_string())),
        summary: Set(None),
        created_at: Set(now),
    };
    Ok(run_to_info(active.insert(conn).await?))
}

/// Bind the produced conversation + live connection + worktree to a run after
/// launch. Only sets the provided fields (None leaves the column unchanged).
pub async fn attach_run_runtime(
    conn: &DatabaseConnection,
    run_id: i32,
    conversation_id: Option<i32>,
    connection_id: Option<String>,
    worktree_folder_id: Option<i32>,
) -> Result<(), DbError> {
    let row = automation_run::Entity::find_by_id(run_id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation_run {run_id}")))?;
    let mut active = row.into_active_model();
    if conversation_id.is_some() {
        active.conversation_id = Set(conversation_id);
    }
    if connection_id.is_some() {
        active.connection_id = Set(connection_id);
    }
    if worktree_folder_id.is_some() {
        active.worktree_folder_id = Set(worktree_folder_id);
    }
    active.update(conn).await?;
    Ok(())
}

/// Settle a run to a terminal state. CAS on `status = running` so an event-driven
/// settle and the reconcile backstop can never double-settle. Denormalizes the
/// outcome onto the parent automation and bumps `unseen_failures` on failure.
/// Returns `true` if this call performed the settle, `false` if already settled.
pub async fn settle_run(
    conn: &DatabaseConnection,
    run_id: i32,
    status: AutomationRunStatus,
    stop_reason: Option<String>,
    error: Option<String>,
    summary: Option<String>,
) -> Result<bool, DbError> {
    use sea_orm::TransactionTrait;
    let txn = conn.begin().await?;
    let now = Utc::now();

    // CAS: flip only a still-running row (idempotent across event + reconcile).
    let flipped = automation_run::Entity::update_many()
        .col_expr(
            automation_run::Column::Status,
            Expr::value(run_status_str(&status)),
        )
        .filter(automation_run::Column::Id.eq(run_id))
        .filter(automation_run::Column::Status.eq(AutomationRunStatus::Running))
        .exec(&txn)
        .await?;
    if flipped.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(false);
    }

    // Fill the remaining run fields.
    let run = automation_run::Entity::find_by_id(run_id)
        .one(&txn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("automation_run {run_id}")))?;
    let automation_id = run.automation_id;
    let conversation_id = run.conversation_id;
    let mut rm = run.into_active_model();
    rm.ended_at = Set(Some(now));
    rm.stop_reason = Set(stop_reason);
    rm.error = Set(error);
    rm.summary = Set(summary);
    rm.update(&txn).await?;

    // Denormalize onto the parent automation (drives the list view + badge).
    if let Some(auto) = automation::Entity::find_by_id(automation_id)
        .one(&txn)
        .await?
    {
        let prev_unseen = auto.unseen_failures;
        let mut am = auto.into_active_model();
        am.last_run_at = Set(Some(now));
        am.last_run_status = Set(Some(run_status_str(&status).to_string()));
        am.last_run_conversation_id = Set(conversation_id);
        if status == AutomationRunStatus::Failed {
            am.unseen_failures = Set(prev_unseen + 1);
        }
        am.update(&txn).await?;
    }

    txn.commit().await?;
    Ok(true)
}

/// All currently-running runs — hydrates the completion index at boot and drives
/// the reconcile sweep.
pub async fn list_active_runs(
    conn: &DatabaseConnection,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    let rows = automation_run::Entity::find()
        .filter(automation_run::Column::Status.eq(AutomationRunStatus::Running))
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(run_to_info).collect())
}

/// On boot no ACP connections survive, so every still-`running` run is an
/// interruption. Fail them (never fake success, never re-fire — the automation
/// re-fires naturally on its next schedule). Returns how many were reconciled.
pub async fn boot_reconcile_interrupted(conn: &DatabaseConnection) -> Result<u64, DbError> {
    let active = list_active_runs(conn).await?;
    let mut n = 0;
    for r in active {
        if settle_run(
            conn,
            r.id,
            AutomationRunStatus::Failed,
            None,
            Some("interrupted by restart".to_string()),
            None,
        )
        .await?
        {
            n += 1;
        }
    }
    Ok(n)
}

// ── scheduling ───────────────────────────────────────────────────────────────

/// Ids of enabled, scheduled automations whose next fire is due (`next_run_at <=
/// now`). NULL `next_run_at` (disabled/manual/exhausted) is excluded.
pub async fn list_due(
    conn: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<Vec<i32>, DbError> {
    let rows = automation::Entity::find()
        .filter(automation::Column::Enabled.eq(true))
        .filter(automation::Column::DeletedAt.is_null())
        .filter(automation::Column::TriggerKind.eq(TriggerKind::Schedule))
        .filter(automation::Column::NextRunAt.lte(now))
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(|m| m.id).collect())
}

/// Atomically claim a due automation's current fire slot: advance `next_run_at`
/// to the next cron instant after `now` via a CAS on the read value, so exactly
/// one runner fires the slot — even across a desktop + server both pointing at
/// the same DB, and across restarts. Returns the claimed slot instant (to stamp
/// on the run), or `None` if not actually due or the race was lost.
///
/// `next_run_at` is recomputed forward from `now` (never replays every missed
/// minute), so a process that was down across a slot catches up with a single
/// fire, not a storm.
pub async fn claim_due(
    conn: &DatabaseConnection,
    automation_id: i32,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, DbError> {
    use sea_orm::TransactionTrait;
    let txn = conn.begin().await?;

    let Some(row) = automation::Entity::find_by_id(automation_id).one(&txn).await? else {
        txn.rollback().await?;
        return Ok(None);
    };
    if !row.enabled || row.deleted_at.is_some() || row.trigger_kind != TriggerKind::Schedule {
        txn.rollback().await?;
        return Ok(None);
    }
    let Some(slot) = row.next_run_at else {
        txn.rollback().await?;
        return Ok(None);
    };
    if slot > now {
        txn.rollback().await?;
        return Ok(None);
    }

    let next = compute_next_run(row.cron.as_deref().unwrap_or(""), &row.timezone, now)?;
    let res = automation::Entity::update_many()
        .col_expr(automation::Column::NextRunAt, Expr::value(next))
        .filter(automation::Column::Id.eq(automation_id))
        .filter(automation::Column::NextRunAt.eq(slot))
        .exec(&txn)
        .await?;
    if res.rows_affected != 1 {
        txn.rollback().await?;
        return Ok(None);
    }
    txn.commit().await?;
    Ok(Some(slot))
}

/// Best-effort retention: delete run rows older than `keep_days`. Spawned
/// conversations / worktrees are the user's artifacts and are NOT touched.
pub async fn prune_old_runs(
    conn: &DatabaseConnection,
    keep_days: i64,
) -> Result<u64, DbError> {
    let cutoff = Utc::now() - chrono::Duration::days(keep_days);
    let res = automation_run::Entity::delete_many()
        .filter(automation_run::Column::CreatedAt.lt(cutoff))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn draft(name: &str, cron: Option<&str>) -> AutomationDraft {
        AutomationDraft {
            name: name.to_string(),
            enabled: true,
            trigger_kind: if cron.is_some() {
                TriggerKind::Schedule
            } else {
                TriggerKind::Manual
            },
            cron: cron.map(|c| c.to_string()),
            timezone: "UTC".to_string(),
            agent_type: "claude_code".to_string(),
            root_folder_id: None,
            isolation: crate::models::IsolationMode::WorktreePerRun,
            branch: None,
            is_remote_branch: false,
            config: serde_json::json!({ "display_text": "do the thing", "prompt_blocks": [] }),
        }
    }

    #[tokio::test]
    async fn create_list_get_roundtrip() {
        let db = fresh_in_memory_db().await;
        let created = create(&db.conn, draft("nightly", Some("0 0 * * *")))
            .await
            .expect("create");
        assert_eq!(created.name, "nightly");
        assert!(created.next_run_at.is_some(), "scheduled+enabled has next_run");

        let listed = list(&db.conn).await.expect("list");
        assert_eq!(listed.len(), 1);
        let fetched = get(&db.conn, created.id).await.expect("get");
        assert_eq!(fetched.id, created.id);
    }

    #[tokio::test]
    async fn manual_has_no_next_run() {
        let db = fresh_in_memory_db().await;
        let created = create(&db.conn, draft("on demand", None)).await.expect("create");
        assert!(created.next_run_at.is_none());
    }

    #[tokio::test]
    async fn toggle_recomputes_next_run() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("nightly", Some("0 0 * * *")))
            .await
            .expect("create");
        let off = set_enabled(&db.conn, a.id, false).await.expect("disable");
        assert!(off.next_run_at.is_none(), "disabled clears next_run");
        let on = set_enabled(&db.conn, a.id, true).await.expect("enable");
        assert!(on.next_run_at.is_some(), "re-enable recomputes next_run");
    }

    #[tokio::test]
    async fn soft_delete_hides() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("temp", Some("*/5 * * * *")))
            .await
            .expect("create");
        delete(&db.conn, a.id).await.expect("delete");
        assert!(list(&db.conn).await.expect("list").is_empty());
        assert!(get(&db.conn, a.id).await.is_err(), "deleted not gettable");
    }

    #[tokio::test]
    async fn validation_rejects_bad_input() {
        let db = fresh_in_memory_db().await;
        assert!(create(&db.conn, draft("", Some("0 0 * * *"))).await.is_err());
        let mut no_prompt = draft("x", Some("0 0 * * *"));
        no_prompt.config = serde_json::json!({ "display_text": "", "prompt_blocks": [] });
        assert!(create(&db.conn, no_prompt).await.is_err());
        let mut bad_cron = draft("x", Some("not a cron"));
        bad_cron.cron = Some("not a cron".to_string());
        assert!(create(&db.conn, bad_cron).await.is_err());
        let mut sched_no_cron = draft("x", Some("0 0 * * *"));
        sched_no_cron.cron = None;
        assert!(create(&db.conn, sched_no_cron).await.is_err());
    }

    #[test]
    fn compute_next_run_daily_utc() {
        let after = DateTime::parse_from_rfc3339("2026-06-21T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let next = compute_next_run("0 0 * * *", "UTC", after)
            .expect("compute")
            .expect("has next");
        assert_eq!(next.to_rfc3339(), "2026-06-22T00:00:00+00:00");
    }

    #[test]
    fn compute_next_run_honors_timezone() {
        // Daily midnight in Shanghai (UTC+8) = 16:00 UTC the previous day.
        let after = DateTime::parse_from_rfc3339("2026-06-21T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let next = compute_next_run("0 0 * * *", "Asia/Shanghai", after)
            .expect("compute")
            .expect("has next");
        assert_eq!(next.to_rfc3339(), "2026-06-21T16:00:00+00:00");
    }

    #[test]
    fn compute_next_run_rejects_bad_tz() {
        let now = Utc::now();
        assert!(compute_next_run("0 0 * * *", "Not/AZone", now).is_err());
    }

    #[tokio::test]
    async fn run_lifecycle_settle_is_idempotent() {
        let db = fresh_in_memory_db().await;
        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/automation-test").await;
        let conv_id = crate::db::test_helpers::seed_conversation(
            &db,
            folder_id,
            crate::models::AgentType::ClaudeCode,
        )
        .await;
        let a = create(&db.conn, draft("nightly", Some("0 0 * * *")))
            .await
            .unwrap();
        assert!(!has_active_run(&db.conn, a.id).await.unwrap());

        let run = start_run(&db.conn, a.id, "manual", None).await.unwrap();
        assert!(has_active_run(&db.conn, a.id).await.unwrap());
        attach_run_runtime(&db.conn, run.id, Some(conv_id), Some("conn-1".into()), None)
            .await
            .unwrap();

        // First settle wins; a second (event vs reconcile race) is a no-op.
        assert!(settle_run(
            &db.conn,
            run.id,
            AutomationRunStatus::Succeeded,
            Some("end_turn".into()),
            None,
            Some("did it".into()),
        )
        .await
        .unwrap());
        assert!(!settle_run(
            &db.conn,
            run.id,
            AutomationRunStatus::Failed,
            None,
            Some("late".into()),
            None,
        )
        .await
        .unwrap());

        assert!(!has_active_run(&db.conn, a.id).await.unwrap());
        let got = get(&db.conn, a.id).await.unwrap();
        assert_eq!(got.last_run_status.as_deref(), Some("succeeded"));
        assert_eq!(got.last_run_conversation_id, Some(conv_id));
        assert_eq!(got.unseen_failures, 0);
    }

    #[tokio::test]
    async fn failed_run_bumps_unseen_until_marked() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("x", Some("0 0 * * *"))).await.unwrap();
        let run = start_run(&db.conn, a.id, "schedule", None).await.unwrap();
        settle_run(
            &db.conn,
            run.id,
            AutomationRunStatus::Failed,
            None,
            Some("boom".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(get(&db.conn, a.id).await.unwrap().unseen_failures, 1);
        mark_all_seen(&db.conn).await.unwrap();
        assert_eq!(get(&db.conn, a.id).await.unwrap().unseen_failures, 0);
    }

    #[tokio::test]
    async fn boot_reconcile_fails_active_runs() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("x", Some("0 0 * * *"))).await.unwrap();
        let _ = start_run(&db.conn, a.id, "schedule", None).await.unwrap();
        assert_eq!(boot_reconcile_interrupted(&db.conn).await.unwrap(), 1);
        assert!(!has_active_run(&db.conn, a.id).await.unwrap());
        let runs = list_runs(&db.conn, a.id, 10).await.unwrap();
        assert_eq!(runs[0].status, AutomationRunStatus::Failed);
        assert_eq!(runs[0].error.as_deref(), Some("interrupted by restart"));
    }

    #[tokio::test]
    async fn skipped_run_recorded() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("x", Some("0 0 * * *"))).await.unwrap();
        record_skipped_run(&db.conn, a.id, "schedule", None)
            .await
            .unwrap();
        let runs = list_runs(&db.conn, a.id, 10).await.unwrap();
        assert_eq!(runs[0].status, AutomationRunStatus::Skipped);
    }

    async fn force_next_run_at(db: &crate::db::AppDatabase, id: i32, at: DateTime<Utc>) {
        let mut am = automation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        am.next_run_at = Set(Some(at));
        am.update(&db.conn).await.unwrap();
    }

    #[tokio::test]
    async fn claim_due_is_exclusive_and_advances() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("min", Some("* * * * *"))).await.unwrap();
        let past = Utc::now() - chrono::Duration::minutes(5);
        force_next_run_at(&db, a.id, past).await;

        assert_eq!(list_due(&db.conn, Utc::now()).await.unwrap(), vec![a.id]);

        // First claim wins and returns the slot it consumed.
        assert_eq!(claim_due(&db.conn, a.id, Utc::now()).await.unwrap(), Some(past));
        // Second claim of the same slot loses (next_run_at already advanced).
        assert!(claim_due(&db.conn, a.id, Utc::now()).await.unwrap().is_none());
        // next_run_at jumped to a future slot — no replay of missed minutes.
        assert!(get(&db.conn, a.id).await.unwrap().next_run_at.unwrap() > Utc::now());
        // No longer due.
        assert!(list_due(&db.conn, Utc::now()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn disabled_automation_not_due() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("x", Some("* * * * *"))).await.unwrap();
        force_next_run_at(&db, a.id, Utc::now() - chrono::Duration::minutes(1)).await;
        set_enabled(&db.conn, a.id, false).await.unwrap();
        // Disable clears next_run_at, so it's not due and claim is a no-op.
        assert!(list_due(&db.conn, Utc::now()).await.unwrap().is_empty());
        assert!(claim_due(&db.conn, a.id, Utc::now()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn prune_removes_old_runs() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, draft("x", Some("0 0 * * *"))).await.unwrap();
        let run = start_run(&db.conn, a.id, "schedule", None).await.unwrap();
        let mut rm = automation_run::Entity::find_by_id(run.id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
        rm.created_at = Set(Utc::now() - chrono::Duration::days(60));
        rm.update(&db.conn).await.unwrap();

        assert_eq!(prune_old_runs(&db.conn, 30).await.unwrap(), 1);
        assert!(list_runs(&db.conn, a.id, 10).await.unwrap().is_empty());
    }
}
