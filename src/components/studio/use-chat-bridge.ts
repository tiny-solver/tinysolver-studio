"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react"

import { pushEngineError } from "@/lib/studio/agent-context"
import {
  emitAppendTextToSession,
  emitAttachFileToSession,
} from "@/lib/session-attachment-events"
import { useTabStore } from "@/stores/tab-store"

/**
 * The Studio pane sits beside a conversation. This resolves that conversation
 * (the active conversation tab — file-pane tabs live in a separate list, so
 * focusing the Studio does not change it) and puts text, plus optionally a
 * file badge, into its composer. Nothing is sent: the user adds their request
 * and presses send. Same addressing the file pane's "Add to chat" uses.
 */
export function useChatBridge() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessionTabId = useMemo(() => {
    const active = tabs.find((tab) => tab.id === activeTabId)
    return active && active.kind === "conversation" ? active.id : null
  }, [tabs, activeTabId])

  const send = useCallback(
    (text: string, filePath?: string | null): boolean => {
      if (!sessionTabId) return false
      if (filePath)
        emitAttachFileToSession({ tabId: sessionTabId, path: filePath })
      emitAppendTextToSession({ tabId: sessionTabId, text })
      return true
    },
    [sessionTabId]
  )

  return { canSend: sessionTabId !== null, send }
}

const NO_ERRORS: string[] = []

/**
 * The last few runtime errors of a preview, scoped to `resetKey`: when the
 * key changes (the iframe reloaded, another scene opened) the list reads as
 * empty again without an effect having to clear it — the old errors were
 * about code that is no longer running.
 */
export function useEngineErrorList(resetKey: unknown) {
  const [state, setState] = useState<{ key: unknown; list: string[] }>({
    key: resetKey,
    list: NO_ERRORS,
  })
  const errors = state.key === resetKey ? state.list : NO_ERRORS
  const push = useCallback(
    (message: string) =>
      setState((prev) => ({
        key: resetKey,
        list: pushEngineError(
          prev.key === resetKey ? prev.list : NO_ERRORS,
          message
        ),
      })),
    [resetKey]
  )
  const clear = useCallback(
    () => setState({ key: resetKey, list: NO_ERRORS }),
    [resetKey]
  )
  return { errors, push, clear }
}

/**
 * Runtime errors the preview server's injected reporter posts from a game
 * iframe (`codeg:error`), for a component that owns the iframe itself.
 */
export function useEngineErrors(
  frame: RefObject<HTMLIFrameElement | null>,
  resetKey: unknown
): [string[], () => void] {
  const { errors, push, clear } = useEngineErrorList(resetKey)

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { type?: string; message?: unknown } | null
      if (data?.type !== "codeg:error" || typeof data.message !== "string")
        return
      push(data.message.slice(0, 2000))
    }
    window.addEventListener("message", listen)
    return () => window.removeEventListener("message", listen)
  }, [frame, push])

  return [errors, clear]
}
