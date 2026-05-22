"use client"

/**
 * Inline rendering of a delegated child sub-session under the parent's
 * `delegate_to_agent` ToolCallBlock. Renders as a self-contained card —
 * never falls through the generic tool-call shell — so users see "Agent
 * delegating: task" instead of "mcp__codeg-delegate__delegate_to_agent: codex".
 *
 * Layout:
 *   * Header (always visible): AgentIcon + agent name · "delegated" label
 *     + status badge + chevron.
 *   * Task row: the prompt the parent sent to the child.
 *   * Expanded body: scrollable preview of the child's turns. Fetched
 *     lazily on first expand.
 */

import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { MessageResponse } from "@/components/ai-elements/message"
import { useDelegatedSubSession } from "@/hooks/use-delegated-sub-session"
import {
  AGENT_LABELS,
  type AgentType,
  type ContentBlock,
  type MessageTurn,
} from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

interface Props {
  parentToolUseId: string
  /** Raw JSON arguments the LLM sent to `delegate_to_agent`. Used to
   *  surface the task and agent_type before the broker's
   *  DelegationStarted event lands (or when binding never arrives — e.g.
   *  the wider session was reloaded with an inline child still around). */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}

type ParsedInput = {
  agentType: AgentType | null
  task: string | null
  workingDir: string | null
  timeoutSeconds: number | null
}

const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set<AgentType>([
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "cline",
  "open_claw",
])

function parseInput(raw: string | null | undefined): ParsedInput {
  if (!raw || typeof raw !== "string") {
    return {
      agentType: null,
      task: null,
      workingDir: null,
      timeoutSeconds: null,
    }
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const at = typeof obj.agent_type === "string" ? obj.agent_type : null
    return {
      agentType: at && KNOWN_AGENT_TYPES.has(at) ? (at as AgentType) : null,
      task: typeof obj.task === "string" ? obj.task : null,
      workingDir: typeof obj.working_dir === "string" ? obj.working_dir : null,
      timeoutSeconds:
        typeof obj.timeout_seconds === "number" ? obj.timeout_seconds : null,
    }
  } catch {
    return {
      agentType: null,
      task: null,
      workingDir: null,
      timeoutSeconds: null,
    }
  }
}

/**
 * Best-effort extraction of human-readable result text from the
 * `delegate_to_agent` MCP tool's output. The broker's wire shape is
 *   { kind: "ok", text: "...", child_conversation_id, ... }
 *   { kind: "err", code: "...", message: "..." }
 * but the surrounding tool-call layer may JSON-stringify it OR pass it
 * through verbatim. Try the structured shape first; fall back to the
 * raw string for plain-text outputs.
 */
function parseDelegationOutcome(raw: string | null | undefined): {
  text: string
  isError: boolean
} | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const v = JSON.parse(trimmed) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const kind = typeof obj.kind === "string" ? obj.kind : null
      if (kind === "ok") {
        const text = typeof obj.text === "string" ? obj.text : ""
        return { text, isError: false }
      }
      if (kind === "err") {
        const message = typeof obj.message === "string" ? obj.message : ""
        const code = typeof obj.code === "string" ? obj.code : ""
        return {
          text: message || code || "Delegation failed.",
          isError: true,
        }
      }
      // Other JSON shapes — pretty-print so we don't surface raw braces.
      return {
        text: "```json\n" + JSON.stringify(v, null, 2) + "\n```",
        isError: false,
      }
    }
    // JSON-parsed primitive — render directly.
    return { text: String(v), isError: false }
  } catch {
    return { text: trimmed, isError: false }
  }
}

export function DelegatedSubThread({
  parentToolUseId,
  input,
  output,
  errorText,
  state,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const [expanded, setExpanded] = useState(false)
  const { binding, detail, loading, error } = useDelegatedSubSession(
    parentToolUseId,
    { enabled: expanded }
  )

  const parsed = useMemo(() => parseInput(input), [input])

  // Prefer binding-derived state (live event stream) when present, fall
  // back to the parent ToolCall's own state/output so we still draw a
  // sensible card even if the delegation events never arrived.
  const agentType: AgentType | null = binding?.agentType ?? parsed.agentType
  const status: "running" | "ok" | "err" = (() => {
    if (binding) return binding.status
    if (state === "output-error" || errorText) return "err"
    if (state === "output-available" && output) return "ok"
    return "running"
  })()
  const errorCode = binding?.errorCode

  // Parse the broker's structured outcome out of the raw tool output so
  // the expanded body can render markdown text instead of `{"kind":"ok",
  // "text":"..."}` JSON. Falls back to errorText when the tool errored.
  const outcome = useMemo(() => {
    if (errorText) {
      const parsed = parseDelegationOutcome(errorText)
      if (parsed) return { ...parsed, isError: true }
    }
    return parseDelegationOutcome(output)
  }, [output, errorText])

  // Caller (ToolCallPart) already guarantees this is a `delegate_to_agent`
  // tool, but a snapshot replay with an empty/unparseable input AND no live
  // binding has no useful card to draw — fall through to the standard
  // renderer instead of showing an "unknown sub-agent" stub. Placed AFTER
  // all hooks so the hook order stays stable on re-render.
  if (!binding && !parsed.agentType && !parsed.task) {
    return null
  }

  return (
    <div
      data-testid="delegated-sub-thread"
      className="rounded-lg border border-border bg-card"
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors rounded-t-lg"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
          {agentType ? (
            <AgentIcon agentType={agentType} className="h-3.5 w-3.5" />
          ) : (
            <span className="h-2 w-2 rounded-sm bg-muted-foreground/60" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {agentType ? AGENT_LABELS[agentType] : t("unknownAgent")}
            </span>
            <StatusBadge status={status} errorCode={errorCode} />
          </div>
          {parsed.task && (
            <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-2">
              {parsed.task}
            </div>
          )}
        </div>
        <span className="mt-1 shrink-0 text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 max-h-96 overflow-auto text-xs space-y-3">
          <ExpandedBody
            status={status}
            loading={loading}
            error={error}
            detail={detail}
            outcome={outcome}
            tWaitingForChild={t("waitingForChild")}
            tLoading={t("loading")}
            tLoadFailed={(detailMsg) => t("loadFailed", { detail: detailMsg })}
            tNoDetail={t("noDetail")}
          />
        </div>
      )}
    </div>
  )
}

function ExpandedBody({
  status,
  loading,
  error,
  detail,
  outcome,
  tWaitingForChild,
  tLoading,
  tLoadFailed,
  tNoDetail,
}: {
  status: "running" | "ok" | "err"
  loading: boolean
  error: string | null
  detail: { turns: MessageTurn[] } | null
  outcome: { text: string; isError: boolean } | null
  tWaitingForChild: string
  tLoading: string
  tLoadFailed: (detail: string) => string
  tNoDetail: string
}) {
  const hasTurns = !!detail && detail.turns.length > 0
  const hasOutcome = !!outcome && outcome.text.length > 0

  // Priority:
  //   1. detail turns from the child conversation (richest view)
  //   2. parsed outcome from the parent's tool_result (lighter — only the
  //      final assistant text or the failure message, but always available
  //      the moment the broker returns even if the live binding never
  //      reached the UI)
  //   3. fetch in flight (loading spinner)
  //   4. fetch failed (error)
  //   5. still running and the parent ToolCall hasn't produced output yet
  //      (the "waiting" spinner)
  //   6. completed but nothing to show (noDetail)
  if (hasTurns) {
    return <SubThreadPreview turns={detail!.turns} />
  }
  if (hasOutcome) {
    return (
      <DelegationOutcomeText text={outcome!.text} isError={outcome!.isError} />
    )
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{tLoading}</span>
      </div>
    )
  }
  if (error) {
    return <div className="text-destructive">{tLoadFailed(error)}</div>
  }
  if (status === "running") {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{tWaitingForChild}</span>
      </div>
    )
  }
  return <div className="text-muted-foreground">{tNoDetail}</div>
}

function DelegationOutcomeText({
  text,
  isError,
}: {
  text: string
  isError: boolean
}) {
  return (
    <div
      className={
        isError
          ? 'text-destructive prose prose-sm dark:prose-invert max-w-none break-words [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'
          : 'prose prose-sm dark:prose-invert max-w-none break-words [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'
      }
    >
      <MessageResponse>{text}</MessageResponse>
    </div>
  )
}

function StatusBadge({
  status,
  errorCode,
}: {
  status: "running" | "ok" | "err"
  errorCode?: string
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        {t("running")}
      </span>
    )
  }
  if (status === "ok") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
        {t("ok")}
      </span>
    )
  }
  return (
    <span
      className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
      title={errorCode ?? undefined}
    >
      <ErrorLabel code={errorCode} />
    </span>
  )
}

function ErrorLabel({ code }: { code?: string }) {
  const t = useTranslations("Folder.chat.delegation.status.err")
  switch (code) {
    case "delegation_disabled":
      return <>{t("delegation_disabled")}</>
    case "depth_limit":
      return <>{t("depth_limit")}</>
    case "invalid_agent_type":
      return <>{t("invalid_agent_type")}</>
    case "spawn_failed":
      return <>{t("spawn_failed")}</>
    case "send_failed":
      return <>{t("send_failed")}</>
    case "timeout":
      return <>{t("timeout")}</>
    case "canceled":
      return <>{t("canceled")}</>
    default:
      return <>{t("default")}</>
  }
}

function SubThreadPreview({ turns }: { turns: MessageTurn[] }) {
  if (turns.length === 0) {
    return <span className="text-muted-foreground">— no messages yet —</span>
  }
  return (
    <div className="space-y-2">
      {turns.map((turn) => (
        <TurnRow key={turn.id} turn={turn} />
      ))}
    </div>
  )
}

function TurnRow({ turn }: { turn: MessageTurn }) {
  const roleLabel =
    turn.role === "user"
      ? "User"
      : turn.role === "assistant"
        ? "Assistant"
        : "System"
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {roleLabel}
      </div>
      {turn.blocks.map((b, i) => (
        <BlockLine key={i} block={b} />
      ))}
    </div>
  )
}

function BlockLine({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    if (block.text.trim().length === 0) return null
    return (
      <div className='break-words text-foreground/90 prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'>
        <MessageResponse>{block.text}</MessageResponse>
      </div>
    )
  }
  if (block.type === "thinking") {
    if (block.text.trim().length === 0) return null
    return (
      <div className="whitespace-pre-wrap text-muted-foreground italic">
        {block.text}
      </div>
    )
  }
  if (block.type === "tool_use") {
    return (
      <div className="text-muted-foreground">
        <span className="font-mono">⚙ {block.tool_name}</span>
      </div>
    )
  }
  if (block.type === "tool_result") {
    return (
      <div className="text-muted-foreground">
        <span className="font-mono">{block.is_error ? "✕" : "✓"} result</span>
      </div>
    )
  }
  return null
}
