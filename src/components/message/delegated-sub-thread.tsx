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

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react"
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { MessageResponse } from "@/components/ai-elements/message"
import { useDelegatedSubSession } from "@/hooks/use-delegated-sub-session"
import { AGENT_LABELS, type AgentType } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import {
  type DelegationStatus,
  useDelegation,
} from "@/contexts/delegation-context"
import {
  useAcpActions,
  useConnectionStore,
  type ConnectionState,
  type PendingPermission as ChildPendingPermission,
} from "@/contexts/acp-connections-context"
import { PermissionDialog } from "@/components/chat/permission-dialog"

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
  /**
   * ACP extensibility metadata on this tool call. Read here as a
   * tertiary fallback after the live `DelegationContext` binding when
   * the parent UI re-mounted on a page refresh and the live
   * `delegation_started` event was already consumed (lost): the
   * snapshot's `ToolCallState.meta["codeg.delegation"]` carries enough
   * to re-bind the card to the child conversation.
   */
  meta?: Record<string, unknown> | null
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

/**
 * Subscribe to the child connection's `ConnectionState` (live message,
 * pending permission, etc.) from the shared connections store. Returns
 * `undefined` while no synthetic entry exists yet — caller falls back to
 * the binding / persisted-turns view. Re-renders on every state change
 * via `useSyncExternalStore`.
 */
function useDelegationChildLive(
  childConnectionId: string | null
): ConnectionState | undefined {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!childConnectionId) return () => {}
      return store.subscribeKey(childConnectionId, cb)
    },
    [store, childConnectionId]
  )
  const getSnapshot = useCallback(
    () =>
      childConnectionId ? store.getConnection(childConnectionId) : undefined,
    [store, childConnectionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

type ParsedMeta = {
  status: DelegationStatus
  childConnectionId: string | null
  childConversationId: number | null
  errorCode: string | null
}

/**
 * Extract delegation state from a `ToolCallState.meta` value. Returns
 * `null` when the meta doesn't carry the `codeg.delegation` sub-object —
 * caller falls back to the live binding / `parseInput` chain.
 *
 * The shape mirrors what the broker writes via `DelegationMetaWriter`:
 *   `{ "codeg.delegation": { status, child_connection_id?,
 *     child_conversation_id?, error_code? } }`
 */
function parseDelegationMeta(
  meta: Record<string, unknown> | null | undefined
): ParsedMeta | null {
  if (!meta || typeof meta !== "object") return null
  const inner = meta["codeg.delegation"]
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null
  const obj = inner as Record<string, unknown>
  const rawStatus = obj["status"]
  let status: DelegationStatus
  switch (rawStatus) {
    case "running":
    case "pending":
      status = "running"
      break
    case "completed":
    case "ok":
      status = "ok"
      break
    case "failed":
    case "err":
      status = "err"
      break
    default:
      return null
  }
  const child_connection_id = obj["child_connection_id"]
  const child_conversation_id = obj["child_conversation_id"]
  const error_code = obj["error_code"]
  return {
    status,
    childConnectionId:
      typeof child_connection_id === "string" ? child_connection_id : null,
    childConversationId:
      typeof child_conversation_id === "number" ? child_conversation_id : null,
    errorCode: typeof error_code === "string" ? error_code : null,
  }
}

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
  meta,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  // expanded is driven by user click OR by the arrival of a child
  // pending permission. useReducer (not useState) so the in-effect
  // auto-expand dispatch on first permission appearance doesn't trip
  // the `react-hooks/set-state-in-effect` lint rule — same pattern as
  // `use-delegated-sub-session.ts`.
  const [expanded, dispatchExpand] = useReducer(
    (prev: boolean, action: "toggle" | "force-open"): boolean => {
      if (action === "force-open") return true
      return !prev
    },
    false
  )
  const parsed = useMemo(() => parseInput(input), [input])
  const parsedMeta = useMemo(() => parseDelegationMeta(meta), [meta])
  const { findByParentToolUseId } = useDelegation()
  const { attachDelegationChild, respondPermission } = useAcpActions()
  // `enabled: false` — we no longer surface the child conversation's
  // intermediate turns in the parent UI (only the broker's final outcome
  // text), so there's no reason to fetch the persisted detail. The hook
  // is still useful for the `binding` it returns (agent type, status,
  // child ids derived from the live `DelegationContext` map).
  const { binding } = useDelegatedSubSession(parentToolUseId, {
    enabled: false,
  })

  // Live view of the child connection's streaming state. Drives the
  // expanded body's "streaming" branch — text/thinking/tool-call deltas
  // reach this card the moment they arrive on the child's ACP stream,
  // not just after the broker resolves.
  const childConnectionId =
    binding?.childConnectionId ?? parsedMeta?.childConnectionId ?? null
  const childLive = useDelegationChildLive(childConnectionId)
  const childPendingPermission = childLive?.pendingPermission ?? null

  // Auto-expand the card the *first* time the child raises a permission
  // request — the user has to act on it. Tracked via a ref so a user
  // who deliberately collapses afterwards isn't forced back open on
  // every reducer notify (the request_id stays the same across
  // re-renders).
  const lastSeenPermissionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const reqId = childPendingPermission?.request_id ?? null
    if (reqId && reqId !== lastSeenPermissionIdRef.current) {
      lastSeenPermissionIdRef.current = reqId
      dispatchExpand("force-open")
    }
    if (!reqId) {
      lastSeenPermissionIdRef.current = null
    }
  }, [childPendingPermission])

  // Inline approve/deny — dispatch via the child connection's id, not
  // the parent's. PermissionDialog already routes via the connectionId
  // passed at construction time; for delegation the only consumer is
  // this card, so wiring the child's id directly here is sufficient.
  const onRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!childConnectionId) return
      void respondPermission(childConnectionId, requestId, optionId)
    },
    [childConnectionId, respondPermission]
  )

  // Snapshot-recovery seed: when the parent's tool-call snapshot carries
  // `meta["codeg.delegation"] = { status: "running", child_connection_id }`
  // but the live `delegation_started` event has already been consumed
  // (e.g. page refresh mid-delegation), pull the child connection into
  // the reducer here so its streaming text reaches this card. Idempotent
  // because `attachDelegationChild` early-returns when the synthetic
  // entry already exists.
  useEffect(() => {
    const liveBinding = findByParentToolUseId(parentToolUseId)
    if (!parsedMeta) return
    if (parsedMeta.status !== "running") return
    if (!parsedMeta.childConnectionId) return
    if (liveBinding) return
    if (!parsed.agentType) return
    attachDelegationChild({
      connectionId: parsedMeta.childConnectionId,
      // We don't know the parent's connection_id at this layer (the
      // ToolCallPart doesn't carry it). Pass an empty string — the
      // synthetic ConnectionState only uses parentConnectionId for
      // diagnostic / cascade-cancel hooks; the routing of incoming
      // events is by child connection_id alone.
      parentConnectionId: "",
      parentToolUseId,
      agentType: parsed.agentType,
    })
  }, [
    attachDelegationChild,
    findByParentToolUseId,
    parentToolUseId,
    parsed.agentType,
    parsedMeta,
  ])

  // Prefer binding-derived state (live event stream) when present, then
  // the persisted `meta["codeg.delegation"]` from the snapshot (page
  // refresh recovery), then the parent ToolCall's own state/output as a
  // last resort.
  const agentType: AgentType | null = binding?.agentType ?? parsed.agentType
  const status: "running" | "ok" | "err" = (() => {
    if (binding) return binding.status
    if (parsedMeta) return parsedMeta.status
    if (state === "output-error" || errorText) return "err"
    if (state === "output-available") return "ok"
    return "running"
  })()
  const errorCode = binding?.errorCode ?? parsedMeta?.errorCode ?? undefined

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

  // Real-time view of the child's assistant text — *all* text segments
  // concatenated in arrival order, with no separator. We deliberately
  // strip:
  //   - thinking blocks (internal reasoning, not the result)
  //   - tool_call / plan blocks (intermediate steps)
  // but we keep every text segment so the user sees the child's visible
  // output grow append-only. Each new segment is appended directly to
  // whatever has accumulated so far; later segments NEVER overwrite
  // earlier ones. Once the broker's outcome lands on `output`,
  // `outcome.text` takes over.
  const liveStreamText = useMemo<string | null>(() => {
    const blocks = childLive?.liveMessage?.content ?? []
    const parts: string[] = []
    for (const b of blocks) {
      if (b.type === "text" && b.text.trim().length > 0) parts.push(b.text)
    }
    if (parts.length === 0) return null
    return parts.join("")
  }, [childLive])

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
        onClick={() => dispatchExpand("toggle")}
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
            outcome={outcome}
            liveStreamText={liveStreamText}
            childPendingPermission={childPendingPermission}
            onRespondPermission={onRespondPermission}
            tSubAgentRunning={t("subAgentRunning")}
            tNoDetail={t("noDetail")}
          />
        </div>
      )}
    </div>
  )
}

function ExpandedBody({
  status,
  outcome,
  liveStreamText,
  childPendingPermission,
  onRespondPermission,
  tSubAgentRunning,
  tNoDetail,
}: {
  status: "running" | "ok" | "err"
  outcome: { text: string; isError: boolean } | null
  liveStreamText: string | null
  childPendingPermission: ChildPendingPermission | null
  onRespondPermission: (requestId: string, optionId: string) => void
  tSubAgentRunning: string
  tNoDetail: string
}) {
  const hasOutcome = !!outcome && outcome.text.length > 0

  // Priority:
  //   1. pending permission — child can't progress until the user acts.
  //   2. broker outcome (authoritative final) — replaces any live preview.
  //   3. running: show whatever text we have (latest segment, persisted
  //      across tool_call gaps) PLUS a trailing "sub-agent running…"
  //      indicator below. The indicator is appended, never substituted —
  //      previously shown text stays in view so the user has a continuous
  //      surface even while the child is mid-tool.
  //   4. noDetail — terminal state with nothing to display.
  if (childPendingPermission) {
    return (
      <PermissionDialog
        permission={childPendingPermission}
        onRespond={onRespondPermission}
      />
    )
  }
  if (hasOutcome) {
    return (
      <DelegationOutcomeText text={outcome!.text} isError={outcome!.isError} />
    )
  }
  if (status === "running") {
    return (
      <div className="space-y-2">
        {liveStreamText && (
          <DelegationOutcomeText text={liveStreamText} isError={false} />
        )}
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{tSubAgentRunning}</span>
        </div>
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
