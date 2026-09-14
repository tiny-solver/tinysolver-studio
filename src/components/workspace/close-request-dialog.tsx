"use client"

/**
 * Answers the main window's close button when the backend cannot decide alone.
 *
 * The backend prevents the close, then emits `app://close-request` to the main
 * window and waits. Nothing else will act on that press: until
 * `resolve_close_request` is called the window stays open and the backend's
 * "a prompt is up" flag suppresses further presses. Every exit from this
 * component therefore has to reach that call — including Esc, which is why the
 * dialog is controlled rather than left to close itself.
 *
 * Mounted in the ROOT layout, not the workspace one: the main window also
 * shows `/login` and the redirecting `/`, and on those routes a workspace-only
 * mount would leave the press unanswered and the close button dead. The root
 * layout is shared with the pet / settings / pet-panel webviews, so the
 * listener is gated on the window label instead.
 *
 * Two prompts, one listener, because they share that single-flag protocol:
 * - `ask` — the first close ever. Offer both actions plus "remember", which is
 *   what turns the preference from a settings page nobody visits into
 *   something the user actually sets.
 * - `confirm_terminals` — the choice is already pinned to exit, but live
 *   terminals would die with it. Confirm the loss, do not re-ask the pref.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { listenCloseRequest, resolveCloseRequest } from "@/lib/api"
import { getCurrentWindow, isDesktop } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import type { CloseRequestPayload } from "@/lib/types"

type CloseAction = "minimize" | "exit" | "cancel"

/** The only window whose close button routes through this prompt. */
const MAIN_WINDOW_LABEL = "main"

export function CloseRequestDialog() {
  const t = useTranslations("CloseRequestDialog")
  const [request, setRequest] = useState<CloseRequestPayload | null>(null)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  // Read inside the async responder, which is created once per render but may
  // fire after a state change; a ref keeps it reading the live value.
  const rememberRef = useRef(false)
  rememberRef.current = remember

  useEffect(() => {
    if (!isDesktop()) return

    let disposed = false
    let unsubscribe: (() => void) | null = null

    // The prompt flag lives in the backend process, the dialog in this webview.
    // A reload (dev hot-reload, F5, a webview crash-restart) destroys the
    // dialog without resolving it, and the flag then suppresses every later
    // close press for the rest of the session. A freshly mounted listener means
    // no dialog is on screen, so any flag still set is stale: cancel it.
    // Subscribe first, so a press landing in this window is still delivered.
    const clearStalePrompt = () => {
      void resolveCloseRequest("cancel", false).catch((err) => {
        console.error("[close] failed to clear stale close request:", err)
      })
    }

    void (async () => {
      const win = await getCurrentWindow()
      if (win?.label !== MAIN_WINDOW_LABEL) return

      const fn = await listenCloseRequest((payload) => {
        // Fresh prompt, fresh checkbox: "remember" is a decision about this
        // press, not a sticky UI preference.
        setRemember(false)
        setBusy(false)
        setRequest(payload)
      })
      if (disposed) {
        fn()
        return
      }
      unsubscribe = fn
      clearStalePrompt()
    })().catch((err) => {
      console.error("[close] failed to subscribe to close requests:", err)
    })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const respond = useCallback(
    async (action: CloseAction) => {
      setBusy(true)
      try {
        await resolveCloseRequest(
          action,
          action !== "cancel" && rememberRef.current
        )
        // On `exit` the process is already tearing down and this never runs —
        // harmless, and leaving the dialog up during teardown is preferable to
        // a window that blanks its own prompt before it goes.
        setRequest(null)
      } catch (err) {
        // The backend released its prompt flag before it could fail, so the
        // close button still works. Keep the dialog up and say why.
        toast.error(t("actionFailed", { message: toErrorMessage(err) }))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  if (!request) return null

  const isAsk = request.mode === "ask"
  const terminals = request.running_terminals

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Esc. The backend is still holding the press, so dismissing without
        // telling it would wedge the close button for the rest of the session.
        if (!open && !busy) void respond("cancel")
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isAsk ? t("askTitle") : t("confirmExitTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isAsk ? t("askDescription") : t("confirmExitDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {terminals > 0 && (
          <p className="text-2xs text-amber-500">
            {t("runningTerminals", { count: terminals })}
          </p>
        )}

        {isAsk && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="close-request-remember"
              checked={remember}
              disabled={busy}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <Label
              htmlFor="close-request-remember"
              className="text-xs font-normal text-muted-foreground"
            >
              {t("remember")}
            </Label>
          </div>
        )}

        {/* Recommended action first, escape hatch last. */}
        <AlertDialogFooter>
          {isAsk && (
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void respond("minimize")
              }}
            >
              {t("minimize")}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            variant={isAsk ? "outline" : "destructive"}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void respond("exit")
            }}
          >
            {t("exit")}
          </AlertDialogAction>
          <AlertDialogCancel
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              void respond("cancel")
            }}
          >
            {t("cancel")}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
