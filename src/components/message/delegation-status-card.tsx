"use client"

/**
 * Inline card for the codeg-mcp delegation companion tools
 * `get_delegation_status` and `cancel_delegation`.
 *
 * Design (per product direction): a single collapsed line framed around the
 * user's actual intent — "waiting for task <id>'s result" (status) /
 * "canceling task <id>" (cancel) — followed by the task's execution time and a
 * status badge. The row expands inline to reveal the result, Markdown-rendered.
 * There is no separate "open conversation" affordance — child-session
 * navigation belongs to the `delegate_to_agent` card.
 *
 * Status resolution degrades gracefully; precision hinges on the HOST, not on
 * live-vs-persisted. Neither the ACP live wire nor our persisted tool-result
 * model carries `structuredContent` as a field — the card only ever sees the
 * result TEXT plus an `is_error` flag — so:
 *   - hosts that echo the full MCP `CallToolResult` envelope (or the bare
 *     report JSON) as that text — e.g. Codex's "Wall time:…\nOutput:\n<json>" —
 *     let the card recover the structured `DelegationTaskReport`, so the badge,
 *     duration + result text are precise;
 *   - hosts that surface only `CallToolResult.content` text — e.g. Claude Code
 *     via claude-agent-acp — give no structured fields, so the badge is derived
 *     from the tool-call state / `is_error`, with no duration. That is accurate
 *     for `completed` (ok) and `failed` (err, via `is_error`), but optimistic
 *     for a non-failed terminal/interim poll (`canceled` / `unknown` /
 *     `running`), which reads "done". This does NOT self-heal on reload, since
 *     the persisted tool-result model drops `structuredContent` too.
 */

import { useId, useMemo, useState } from "react"
import { Activity, Ban, ChevronDown, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { extractEmbeddedJsonObject } from "@/lib/embedded-json"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { StatusBadge } from "@/components/message/delegation-status-badge"

interface Props {
  /** Which companion tool this card represents — selects the label + icon. */
  kind: "status" | "cancel"
  /** Raw JSON arguments sent to the tool (`{ task_id, wait_ms? }`). */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}

type BadgeStatus = "starting" | "running" | "waiting" | "ok" | "err"

const TASK_STATUSES = [
  "running",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

type StatusReport = {
  status: TaskStatus | null
  /** Result/message text to reveal on expand (verbatim for the live-wire shape). */
  text: string | null
  /** Wire-stable error code for a failed/canceled report (badge specificity). */
  errorCode: string | null
  /** Task execution time in ms — set only for terminal cached results. */
  durationMs: number | null
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function firstContentText(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.content)) return null
  const first = asObject(envelope.content[0])
  return first ? str(first, "text") : null
}

// Wrapper keys hosts use to nest the actual tool arguments (mirrors
// `delegated-sub-thread.tsx`): JSON-RPC/MCP relays pack the call as
// `{name, arguments}` or `{params: {...}}`; some agents stash args under a
// generic `input`/`payload` key. Walked recursively (small depth cap) so any
// single layer of wrapping — including double-encoded JSON strings — peels off.
const TASK_ID_WRAPPER_KEYS = [
  "arguments",
  "input",
  "params",
  "payload",
  "_meta",
] as const

function findTaskId(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null
  // Some hosts double-encode the input (JSON-of-JSON); parse and recurse once.
  if (typeof value === "string") {
    try {
      return findTaskId(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }
  const obj = asObject(value)
  if (!obj) return null
  const direct = str(obj, "task_id")
  if (direct) return direct
  for (const key of TASK_ID_WRAPPER_KEYS) {
    if (obj[key] === undefined) continue
    const found = findTaskId(obj[key], depth + 1)
    if (found) return found
  }
  return null
}

/** Extract the `task_id` the tool was called with (`{ task_id, wait_ms? }`),
 *  peeling host wrappers and double-encoded JSON. These tools require a
 *  non-empty `task_id`, so a miss should be rare — but degrade gracefully. */
function parseTaskId(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    return findTaskId(JSON.parse(raw))
  } catch {
    // unparseable input — the task ref is just a nicety, skip it
    return null
  }
}

/** The `status` value if it's one of the delegation report statuses, else null. */
function validStatus(obj: Record<string, unknown> | null): TaskStatus | null {
  if (!obj) return null
  const s = obj.status
  return typeof s === "string" &&
    (TASK_STATUSES as readonly string[]).includes(s)
    ? (s as TaskStatus)
    : null
}

/**
 * Whether `obj` is a delegation report. `structuredContent` is trusted (the
 * host only surfaces it for an actual `CallToolResult`). An UNtrusted source —
 * raw output text or `content[0].text`, which on the live wire is the child's
 * own (arbitrary) result — must ALSO carry the report's `task_id`; otherwise a
 * child whose output happens to be JSON-with-`status` would be misread as a
 * report (false failure tint / dropped output). Every real status/cancel report
 * carries `task_id`, so this never rejects a genuine one.
 */
function isReport(
  obj: Record<string, unknown> | null,
  trusted: boolean
): boolean {
  if (!validStatus(obj)) return false
  if (trusted) return true
  return typeof obj!.task_id === "string" && obj!.task_id.length > 0
}

/**
 * Parse the tool output into a delegation report. Handles every shape the
 * report can arrive in:
 *   - the MCP `CallToolResult` envelope (`{ content, structuredContent?,
 *     isError? }`) — persisted / snapshot rows;
 *   - a host-wrapped envelope/report — notably Codex's
 *     `"Wall time:…\nOutput:\n<json>"` (recovered via `extractEmbeddedJsonObject`);
 *   - an inlined report (`{ status, ... }`), incl. one embedded in
 *     `content[0].text` when the host surfaces no `structuredContent`;
 *   - the plain-text result the live stream forwards (no structured fields →
 *     status is derived from the tool-call state instead).
 * Recovering the structured `status` matters because terminal outcomes
 * (`unknown` / `failed` / `canceled`) must not degrade into a non-error row.
 */
function parseStatusReport(
  output: string | null | undefined,
  errorText: string | null | undefined
): StatusReport {
  const empty: StatusReport = {
    status: null,
    text: null,
    errorCode: null,
    durationMs: null,
  }
  const raw = (output ?? errorText ?? "").trim()
  if (!raw) return empty

  let obj: Record<string, unknown> | null
  try {
    obj = asObject(JSON.parse(raw))
  } catch {
    obj = extractEmbeddedJsonObject(raw)
  }
  if (!obj) return { ...empty, text: raw }

  // Locate the structured report across the shapes it can hide in:
  // structuredContent (trusted) → top-level → inlined in content[0].text. The
  // last two are gated on `task_id` so a child's own JSON output isn't misread.
  const contentText = firstContentText(obj)
  const sc = asObject(obj.structuredContent)
  let report: Record<string, unknown> | null = null
  let displayText: string | null = contentText
  if (isReport(sc, true)) {
    report = sc
  } else if (isReport(obj, false)) {
    report = obj
  } else if (contentText) {
    const embedded = extractEmbeddedJsonObject(contentText)
    if (isReport(embedded, false)) {
      report = embedded
      // content[0].text WAS the report JSON, not a human message — fall back to
      // the report's own message/text for display instead of raw JSON.
      displayText = null
    }
  }

  if (report) {
    return {
      status: validStatus(report),
      text: displayText ?? str(report, "text") ?? str(report, "message"),
      errorCode: str(report, "error_code"),
      durationMs: num(report, "duration_ms"),
    }
  }

  return { ...empty, text: contentText ?? raw }
}

/**
 * Resolve the status badge. The structured `status` wins when present
 * (persisted rows); otherwise fall back to the tool-call lifecycle state
 * (live stream, before / without structured output).
 */
function deriveBadge(
  kind: "status" | "cancel",
  report: StatusReport,
  state: ToolCallState | undefined,
  hasError: boolean
): { status: BadgeStatus; errorCode?: string } {
  switch (report.status) {
    case "completed":
      return { status: "ok" }
    case "running":
      // The poll returned while the task is still running — keep it spinning.
      return { status: "running" }
    case "unknown":
      // Terminal "task id not known" — surface as error, not an endless spinner.
      return { status: "err", errorCode: "unknown" }
    case "failed":
      return { status: "err", errorCode: report.errorCode ?? undefined }
    case "canceled":
      // Canceling is the *success* outcome for `cancel_delegation`; for a
      // status query a canceled task is a terminal error.
      return kind === "cancel"
        ? { status: "ok" }
        : { status: "err", errorCode: report.errorCode ?? "canceled" }
    default:
      break
  }
  if (state === "output-error" || hasError) return { status: "err" }
  if (state === "output-available") return { status: "ok" }
  if (state === "input-available" || state === "input-streaming")
    return { status: "running" }
  return { status: "starting" }
}

/** Compact human duration: `350ms`, `1.2s`, `12s`, `2m 0s`. Total seconds are
 *  rounded once before splitting so the remainder never rolls to `60s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
}

export function DelegationStatusCard({
  kind,
  input,
  output,
  errorText,
  state,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()

  const taskId = useMemo(() => parseTaskId(input), [input])
  const report = useMemo(
    () => parseStatusReport(output, errorText),
    [output, errorText]
  )
  const badge = useMemo(
    () => deriveBadge(kind, report, state, !!errorText),
    [kind, report, state, errorText]
  )

  const resultText = report.text
  const expandable = !!resultText
  const isError = badge.status === "err"
  const isRunning = badge.status === "running"
  const duration =
    report.durationMs != null ? formatDuration(report.durationMs) : null

  const shortId = taskId ? taskId.slice(0, 8) : null
  const label =
    kind === "cancel"
      ? shortId
        ? t("cancelTask", { task: `#${shortId}` })
        : t("cancelTaskNoTask")
      : shortId
        ? t("waitForResult", { task: `#${shortId}` })
        : t("waitForResultNoTask")

  const Icon = kind === "cancel" ? Ban : Activity

  const row = (
    <>
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          isError ? "text-destructive" : "text-muted-foreground"
        )}
      />
      <span
        className="min-w-0 truncate text-xs font-medium text-foreground"
        title={taskId ?? undefined}
      >
        {isRunning ? (
          <Shimmer as="span" duration={1} shineColor="var(--primary)">
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      {duration && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {duration}
        </span>
      )}
      <StatusBadge status={badge.status} errorCode={badge.errorCode} />
      {expandable &&
        (expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ))}
    </>
  )

  return (
    <div
      data-testid="delegation-status-card"
      className={cn(
        "rounded-lg border text-xs",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card"
      )}
    >
      {expandable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          // The panel is only mounted while expanded (keeps the heavy Markdown
          // renderer out of the collapsed tree), so only reference it then —
          // avoids a dangling `aria-controls` target while collapsed.
          aria-controls={expanded ? panelId : undefined}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/50"
        >
          {row}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2">{row}</div>
      )}
      {expandable && expanded && (
        <div
          id={panelId}
          className="max-h-80 overflow-auto border-t border-border px-3 pb-2 pt-2"
        >
          <div className='prose prose-sm max-w-none break-words text-xs dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'>
            <MessageResponse>{resultText}</MessageResponse>
          </div>
        </div>
      )}
    </div>
  )
}
