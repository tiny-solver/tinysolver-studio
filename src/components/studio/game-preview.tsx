"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"

import { gamePreviewFingerprint, getContentPreview } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openPath } from "@/lib/platform"
import { buildAgentContext } from "@/lib/studio/agent-context"
import { previewBase } from "@/lib/studio/game-url"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"

import { useChatBridge, useEngineErrors } from "./use-chat-bridge"

const POLL_MS = 1500

/**
 * The project's game, live, in an iframe.
 *
 * The backend serves the project folder over HTTP (`content_preview.rs`;
 * module scripts and import maps need real HTTP). A local desktop window
 * loads its loopback listener directly and keeps `allow-same-origin` (the
 * loopback origin is not the app's, so nothing of the app is reachable). Web
 * windows load `/api/content-preview/<id>/…` and drop `allow-same-origin`:
 * the proxied origin *is* the app origin in production, and an opaque origin
 * is what keeps the game from reading the app's token. The cost is that the
 * game's own localStorage does not persist there, which the note says.
 *
 * Reload is driven by polling a directory fingerprint: the agent writes
 * files, the fingerprint changes, the iframe reloads. Polling pauses while
 * the document is hidden.
 *
 * Runtime errors the preview server's injected reporter posts are shown in
 * a strip and can be handed to the conversation beside the pane — the game
 * here is whatever the agent last wrote, so its errors are the agent's to
 * fix.
 */
export function GamePreview({
  root,
  dir,
  entryFile,
  projectName = null,
}: {
  /** Manifest name, for the context handed to the agent. */
  projectName?: string | null
  root: string
  /** Directory under the project root that holds the game. */
  dir: string
  /** File inside `dir` to open, normally `index.html`. */
  entryFile: string
}) {
  const t = useTranslations("Studio")
  const [server, setServer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [retryKey, setRetryKey] = useState(0)
  const fingerprint = useRef<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [engineErrors, clearEngineErrors] = useEngineErrors(frame, reloadKey)
  const chat = useChatBridge()
  // "Sent" holds only for the list it was sent with; a new error flips the
  // strip back to showing the error.
  const [sentFor, setSentFor] = useState<string[] | null>(null)
  const sent = sentFor === engineErrors
  const sendToChat = () => {
    if (
      chat.send(buildAgentContext({ projectName, gameDir: dir, engineErrors }))
    )
      setSentFor(engineErrors)
  }

  const loopbackDirect = isDesktop() && !isRemoteDesktopMode()
  const remoteDesktop = isDesktop() && isRemoteDesktopMode()

  useEffect(() => {
    if (remoteDesktop) return
    let cancelled = false
    getContentPreview(root)
      .then((info) => {
        if (cancelled) return
        setServer(previewBase(info))
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [root, remoteDesktop, retryKey])

  useEffect(() => {
    if (!server) return
    let stopped = false
    const tick = async () => {
      if (stopped || document.hidden) return
      try {
        const next = await gamePreviewFingerprint(root, dir)
        if (stopped) return
        if (fingerprint.current !== null && fingerprint.current !== next) {
          setReloadKey((k) => k + 1)
        }
        fingerprint.current = next
      } catch {
        /* transient; the next tick retries */
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [server, root, dir])

  const url = server ? `${server}/${dir}/${entryFile}` : null

  const openExternal = useCallback(() => {
    if (!url) return
    if (isDesktop()) openPath(url).catch(() => {})
    else window.open(url, "_blank", "noopener")
  }, [url])

  if (remoteDesktop) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
        <TriangleAlert className="h-6 w-6" />
        {t("previewRemoteUnsupported")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={url ?? undefined}>
          {error
            ? t("previewFailed", { message: error })
            : url
              ? t("previewAutoReload", { dir })
              : t("previewStarting")}
        </span>
        {error ? (
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="rounded px-2 py-0.5 hover:bg-primary/8"
          >
            {t("retry")}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={sendToChat}
              disabled={!chat.canSend}
              aria-label={t("sendToChat")}
              title={
                chat.canSend ? t("sendToChatHint") : t("sendToChatNoSession")
              }
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/8 disabled:opacity-40"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={!url}
              aria-label={t("previewReload")}
              title={t("previewReload")}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/8 disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={openExternal}
              disabled={!url}
              aria-label={t("previewOpen")}
              title={t("previewOpen")}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-primary/8 disabled:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      {engineErrors.length > 0 && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive"
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span
            className="min-w-0 flex-1 truncate"
            title={engineErrors.join("\n\n")}
          >
            {sent
              ? t("contextSent")
              : `${t("engineErrors", { count: engineErrors.length })} · ${
                  engineErrors[engineErrors.length - 1].split("\n")[0]
                }`}
          </span>
          <button
            type="button"
            onClick={sendToChat}
            disabled={!chat.canSend}
            title={chat.canSend ? undefined : t("sendToChatNoSession")}
            className="shrink-0 rounded px-2 py-0.5 hover:bg-destructive/15 disabled:opacity-50"
          >
            {t("sendToChat")}
          </button>
          <button
            type="button"
            onClick={clearEngineErrors}
            className="shrink-0 rounded px-2 py-0.5 hover:bg-destructive/15"
          >
            {t("dismiss")}
          </button>
        </div>
      )}
      {url ? (
        <iframe
          ref={frame}
          key={reloadKey}
          src={url}
          title={t("gameView")}
          className="min-h-0 flex-1 border-0 bg-black"
          sandbox={
            loopbackDirect
              ? "allow-scripts allow-same-origin allow-pointer-lock allow-forms"
              : "allow-scripts allow-pointer-lock allow-forms"
          }
          allow="autoplay; fullscreen; gamepad"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {error ? null : <Loader2 className="h-4 w-4 animate-spin" />}
        </div>
      )}
      {!loopbackDirect && url && (
        <div className="shrink-0 border-t border-border/50 px-3 py-1 text-[11px] text-muted-foreground">
          {t("previewWebNote")}
        </div>
      )}
    </div>
  )
}
