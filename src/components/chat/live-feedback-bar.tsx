"use client"

/**
 * Live-feedback ("steering") bar shown above the composer while the agent is
 * working, when the feature is enabled. The user types a short note; it is
 * delivered to the agent the next time it calls the `check_user_feedback` MCP
 * tool. Submitted notes render as chips that flip from "waiting" to "received"
 * once the agent reads them (driven by the `feedback_submitted` /
 * `feedback_consumed` events).
 *
 * Cooperative by design: the agent must call the tool to see a note, so this is
 * a side channel, not a hard interrupt. If a turn ends with notes the agent
 * never read, the bar offers to resend them as an ordinary prompt (routed
 * through the message queue so it's never silently dropped).
 *
 * State is hydrated from the session snapshot on mount / connection change (so a
 * refresh or a second mid-turn viewer recovers pending notes) and then kept live
 * via the `feedback_submitted` / `feedback_consumed` event stream. Consumed-id
 * tombstones reconcile a consume event that races ahead of hydration.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Clock, Loader2, MessageSquarePlus, Send, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAcpEvent } from "@/contexts/acp-connections-context"
import { acpGetSessionSnapshot, submitSessionFeedback } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { isNoActiveTurnRejection } from "@/lib/turn-busy"
import type { ConnectionStatus, FeedbackItem } from "@/lib/types"

/** Merge snapshot-hydrated notes with live ones, keyed by id; live entries win
 *  (they carry the most recent status). Snapshot order first, live-only after. */
function mergeNotes(
  base: FeedbackItem[],
  live: FeedbackItem[]
): FeedbackItem[] {
  const byId = new Map<string, FeedbackItem>()
  for (const n of base) byId.set(n.id, n)
  for (const n of live) byId.set(n.id, n)
  return [...byId.values()]
}

interface LiveFeedbackBarProps {
  connectionId: string | null
  connStatus: ConnectionStatus | null
  /** Whether the live-feedback feature is enabled (global setting). */
  enabled: boolean
  agentName?: string
  /** Resend an unread note as an ordinary prompt when the turn ended before
   *  the agent checked. */
  onResendAsPrompt?: (text: string) => void
}

export function LiveFeedbackBar({
  connectionId,
  connStatus,
  enabled,
  agentName,
  onResendAsPrompt,
}: LiveFeedbackBarProps) {
  const t = useTranslations("LiveFeedback")
  const [notes, setNotes] = useState<FeedbackItem[]>([])
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // Whether THIS agent actually has the `check_user_feedback` tool (from the
  // snapshot). The authoritative gate — enabling the feature mid-session can't
  // retrofit the tool onto an already-running agent, so the global setting alone
  // would wrongly show a non-functional bar. Starts false until the snapshot
  // confirms.
  const [toolAvailable, setToolAvailable] = useState(false)
  // Tombstones for notes consumed via `feedback_consumed` whose `feedback_submitted`
  // we never held (a consume event that lands BEFORE the matching submit — e.g.
  // before snapshot hydration resolves, or out-of-order broadcast). Applied so a
  // stale snapshot or a late submit can't resurrect a note as `pending` after
  // the agent already read it (false "Send as message").
  const consumedRef = useRef<Map<string, string>>(new Map())

  const isPrompting = connStatus === "prompting"

  // Reset on connection change, then hydrate from the snapshot: recover pending
  // notes (a refresh / second mid-turn viewer won't get the one-shot
  // `feedback_submitted` events) AND read the agent's real feedback-tool
  // capability. Live events arriving before the fetch resolves are preserved
  // (live wins in the merge); consumed-id tombstones override stale `pending`.
  useEffect(() => {
    setNotes([])
    setToolAvailable(false)
    consumedRef.current = new Map()
    if (!enabled || !connectionId) return
    let cancelled = false
    void acpGetSessionSnapshot(connectionId)
      .then((snap) => {
        if (cancelled || !snap) return
        setToolAvailable(snap.feedback_tool_available ?? false)
        const hydrated = snap.feedback ?? []
        if (hydrated.length === 0) return
        const reconciled = hydrated.map((n) => {
          const at = consumedRef.current.get(n.id)
          return at
            ? { ...n, status: "delivered" as const, delivered_at: at }
            : n
        })
        setNotes((prev) => mergeNotes(reconciled, prev))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [connectionId, enabled])

  // Build the note list from the live event stream, scoped to this connection.
  useAcpEvent(
    useCallback(
      (envelope) => {
        if (envelope.connection_id !== connectionId) return
        switch (envelope.type) {
          case "feedback_submitted": {
            // If a consume already arrived for this id (out-of-order broadcast:
            // the gated submit assigns seq atomically, but stream delivery can
            // still race), honor the tombstone so it never shows as pending.
            const at = consumedRef.current.get(envelope.item.id)
            const item: FeedbackItem = at
              ? { ...envelope.item, status: "delivered", delivered_at: at }
              : envelope.item
            setNotes((prev) =>
              prev.some((n) => n.id === item.id) ? prev : [...prev, item]
            )
            break
          }
          case "feedback_consumed": {
            const ids = new Set(envelope.ids)
            const at = envelope.delivered_at
            // Record tombstones so a not-yet-hydrated note can't later resurface
            // as pending once the snapshot resolves.
            for (const id of envelope.ids) consumedRef.current.set(id, at)
            setNotes((prev) =>
              prev.map((n) =>
                ids.has(n.id)
                  ? { ...n, status: "delivered", delivered_at: at }
                  : n
              )
            )
            break
          }
          case "user_message": {
            // A new turn started — notes are turn-scoped, mirror the backend
            // clear so a fresh turn begins with an empty bar.
            setNotes([])
            consumedRef.current = new Map()
            break
          }
        }
      },
      [connectionId]
    )
  )

  const submit = useCallback(async () => {
    const text = draft.trim()
    if (!text || submitting || !connectionId) return
    setSubmitting(true)
    try {
      const item = await submitSessionFeedback(connectionId, text)
      // Optimistically add; the broadcast event dedups against this by id.
      setNotes((prev) =>
        prev.some((n) => n.id === item.id) ? prev : [...prev, item]
      )
      setDraft("")
    } catch (err: unknown) {
      if (isNoActiveTurnRejection(err)) {
        // The turn ended between typing and sending. Fall back to a normal
        // prompt so the user's intent isn't lost.
        if (onResendAsPrompt) {
          onResendAsPrompt(text)
          setDraft("")
          toast.info(t("turnEndedResent"))
        } else {
          toast.info(t("turnEnded"))
        }
      } else {
        toast.error(t("submitFailed"), { description: toErrorMessage(err) })
      }
    } finally {
      setSubmitting(false)
    }
  }, [draft, submitting, connectionId, onResendAsPrompt, t])

  const pendingNotes = notes.filter((n) => n.status === "pending")
  const hasUnreadAfterTurn = !isPrompting && pendingNotes.length > 0

  // Keep a ref of the latest pending texts for the resend-all action.
  const pendingTextsRef = useRef<string[]>([])
  useEffect(() => {
    pendingTextsRef.current = pendingNotes.map((n) => n.text)
  }, [pendingNotes])

  const resendUnread = useCallback(() => {
    const texts = pendingTextsRef.current
    if (texts.length === 0) return
    onResendAsPrompt?.(texts.join("\n\n"))
    setNotes([])
  }, [onResendAsPrompt])

  const dismissUnread = useCallback(() => setNotes([]), [])

  // Nothing to show: feature off, no live connection, this agent lacks the
  // feedback tool (e.g. its session predates enabling), or idle with no unread.
  if (!enabled || !connectionId || !toolAvailable) return null
  if (!isPrompting && !hasUnreadAfterTurn) return null

  return (
    <div className="mb-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
      {notes.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {notes.map((n) => (
            <span
              key={n.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5"
              title={n.text}
            >
              {n.status === "delivered" ? (
                <Check
                  className="h-3 w-3 shrink-0 text-emerald-500"
                  aria-hidden
                />
              ) : (
                <Clock
                  className="h-3 w-3 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )}
              <span className="truncate">{n.text}</span>
              <span className="shrink-0 text-muted-foreground">
                {n.status === "delivered" ? t("delivered") : t("pending")}
              </span>
            </span>
          ))}
        </div>
      )}

      {hasUnreadAfterTurn ? (
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 text-muted-foreground">
            {t("turnEndedUnread")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={resendUnread}>
              {t("sendAsMessage")}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={dismissUnread}
              title={t("dismiss")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <MessageSquarePlus
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder={t("placeholder", {
              agent: agentName ?? t("agentFallback"),
            })}
            disabled={submitting}
            className="h-8 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
            aria-label={t("ariaLabel")}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 shrink-0"
            onClick={() => void submit()}
            disabled={submitting || draft.trim().length === 0}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">{t("send")}</span>
          </Button>
        </div>
      )}
    </div>
  )
}
