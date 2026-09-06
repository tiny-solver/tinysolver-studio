"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Plug, Unplug, RotateCw, Settings2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  getCodegMcpServiceStatus,
  openSettingsWindow,
  startCodegMcpService,
  type CodegMcpServiceState,
  type CodegMcpServiceStatus,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"

/** Background refresh cadence. The status is a real socket round-trip plus a
 * binary lookup, so this is deliberately slow — the popover refetches on open,
 * which covers every moment someone is actually looking at it. */
const POLL_MS = 60_000

/** `unknown` is frontend-only: the status call itself failed, which says
 * nothing about the service and must not be painted as a service fault. */
type IndicatorState = CodegMcpServiceState | "unknown"

/** Tool-group slugs the backend can send, mapped to their message keys. An
 * unmapped slug (a group added backend-first) falls back to the raw slug rather
 * than throwing a missing-message error. */
type GroupLabelKey =
  | "groupDelegation"
  | "groupFeedback"
  | "groupAsk"
  | "groupSessions"
  | "groupAutomations"
  | "groupTaskboard"

const GROUP_LABEL_KEYS: Record<string, GroupLabelKey | undefined> = {
  delegation: "groupDelegation",
  feedback: "groupFeedback",
  ask: "groupAsk",
  sessions: "groupSessions",
  automations: "groupAutomations",
  taskboard: "groupTaskboard",
}

/** Trigger colour per state. `disabled` stays muted on purpose: the service is
 * healthy, the user simply switched its tools off, and colouring that as a
 * fault would train people to ignore the indicator. */
const TRIGGER_TONE: Record<IndicatorState, string> = {
  running: "text-emerald-500 hover:text-emerald-400",
  disabled: "hover:text-foreground",
  stopped: "text-red-500 hover:text-red-400",
  unavailable: "text-yellow-500 hover:text-yellow-400",
  unknown: "hover:text-foreground",
}

function StateDot({ state }: { state: IndicatorState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "running" && "bg-emerald-500",
        state === "stopped" && "bg-red-500",
        state === "unavailable" && "bg-yellow-500",
        (state === "disabled" || state === "unknown") &&
          "bg-muted-foreground/50"
      )}
    />
  )
}

/** One `label — value` line. `mono` is for paths, which are the thing people
 * copy out of here. */
function DetailRow({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  tone?: "ok" | "bad" | "muted"
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-2xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right text-2xs",
          mono && "font-mono",
          tone === "ok" && "text-emerald-500",
          tone === "bad" && "text-red-500",
          tone === "muted" && "text-muted-foreground",
          !tone && "text-foreground"
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * codeg-mcp service indicator, bottom-right of the workspace.
 *
 * The companion is what carries codeg's own tools into an agent session —
 * delegation, live feedback, ask-user-question, session lookup, the two
 * create-from-chat writers. Until now its three failure modes were all silent
 * from the workspace: a missing companion binary logged one line at spawn time,
 * a dead broker socket logged nothing, and "every tool group switched off"
 * looked identical to both from inside a conversation.
 *
 * So: one dot that says which of those is true, a popover that shows the
 * evidence (socket path, resolved binary, per-group switches, live companion
 * count), and — for the one failure this process can repair — a button that
 * rebinds the socket without an app restart.
 */
export function StatusBarMcp() {
  const t = useTranslations("Folder.statusBar.mcp")
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CodegMcpServiceStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // Guards against a slow in-flight refresh landing after unmount, and against
  // the 60s tick overwriting a fresher result the popover just fetched.
  const seqRef = useRef(0)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await getCodegMcpServiceStatus()
      if (!aliveRef.current || seq !== seqRef.current) return
      setStatus(next)
      setLoadError(null)
    } catch (e) {
      if (!aliveRef.current || seq !== seqRef.current) return
      setLoadError(toErrorMessage(e))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => {
      aliveRef.current = false
      clearInterval(id)
    }
  }, [refresh])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setStartError(null)
      void refresh()
    }
  }

  const handleStart = async () => {
    setStarting(true)
    setStartError(null)
    try {
      await startCodegMcpService()
      await refresh()
    } catch (e) {
      if (aliveRef.current) setStartError(toErrorMessage(e))
    } finally {
      if (aliveRef.current) setStarting(false)
    }
  }

  const state: IndicatorState = loadError
    ? "unknown"
    : (status?.state ?? "unknown")
  const down = state === "stopped" || state === "unavailable"
  const enabledGroups = (status?.tool_groups ?? []).filter((g) => g.enabled)
  // Only the socket is repairable from here; a missing binary needs a
  // reinstall and switched-off groups are a settings write.
  const canStart = state === "stopped" && !!status?.can_start

  const startedLabel =
    status?.started_at != null
      ? new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(
          new Date(status.started_at)
        )
      : null

  // A failed start outranks a recorded bind error — it is the newer fact, and
  // it is the one the user just caused. A stale `last_error` is suppressed
  // while the status itself is unreadable, since `status` is then whatever the
  // last successful poll happened to say.
  const errorBanner = startError
    ? t("startFailed", { message: startError })
    : !loadError && status?.last_error
      ? t("lastError", { message: status.last_error })
      : null

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          aria-label={t("title")}
          title={`${t("title")} · ${t(`state.${state}`)}`}
          className={cn(
            "flex items-center gap-1 transition-colors",
            TRIGGER_TONE[state]
          )}
        >
          {down ? (
            <Unplug className="size-3.5" />
          ) : (
            <Plug className="size-3.5" />
          )}
          {state === "running" && !!status?.session_count && (
            <span>{status.session_count}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <StateDot state={state} />
            <span className="truncate text-xs font-medium">{t("title")}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            title={t("refresh")}
            aria-label={t("refresh")}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCw className="h-3 w-3" />
          </button>
        </div>

        <p className="text-2xs leading-5 text-muted-foreground">
          {loadError
            ? t("loadFailed", { message: loadError })
            : t(`hint.${state}`)}
        </p>

        {status && !loadError && (
          <div className="space-y-1.5 rounded-md border bg-background/70 px-2.5 py-2">
            <DetailRow
              label={t("socket")}
              value={status.listening ? t("socketListening") : t("socketDown")}
              tone={status.listening ? "ok" : "bad"}
            />
            <DetailRow
              label={t("socketPath")}
              value={status.socket_path || "—"}
              mono
              tone="muted"
            />
            <DetailRow
              label={t("binary")}
              value={status.binary_path ?? t("binaryMissing")}
              mono={!!status.binary_path}
              tone={status.binary_path ? "muted" : "bad"}
            />
            {startedLabel && (
              <DetailRow
                label={t("startedAt")}
                value={startedLabel}
                tone="muted"
              />
            )}
            {status.state === "running" && (
              <>
                <DetailRow
                  label={t("sessions")}
                  value={String(status.session_count)}
                />
                <DetailRow
                  label={t("activeDelegations")}
                  value={String(status.active_delegations)}
                />
                <DetailRow
                  label={t("depthLimit")}
                  value={String(status.depth_limit)}
                  tone="muted"
                />
              </>
            )}
          </div>
        )}

        {status && !loadError && (
          <div className="space-y-1.5">
            <div className="text-2xs font-medium text-muted-foreground">
              {t("tools")}
            </div>
            {enabledGroups.length === 0 ? (
              <div className="text-2xs text-muted-foreground/80">
                {t("toolsAllOff")}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {enabledGroups.map((group) => {
                  const key = GROUP_LABEL_KEYS[group.key]
                  return (
                    <span
                      key={group.key}
                      className="rounded bg-accent px-1.5 py-0.5 text-3xs text-accent-foreground"
                    >
                      {key ? t(key) : group.key}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {errorBanner && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-400">
            {errorBanner}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              openSettingsWindow().catch((err) => {
                console.error("[StatusBarMcp] failed to open settings:", err)
              })
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("openSettings")}
          </Button>
          {canStart && (
            <Button
              size="sm"
              onClick={() => void handleStart()}
              disabled={starting}
            >
              <Plug className="h-3.5 w-3.5" />
              {starting ? t("starting") : t("start")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
