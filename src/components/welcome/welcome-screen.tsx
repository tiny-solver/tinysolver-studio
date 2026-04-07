"use client"

import { useState, useEffect, useCallback } from "react"
import { Settings } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loadFolderHistory, openSettingsWindow } from "@/lib/api"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import type { FolderHistoryEntry } from "@/lib/types"
import { FolderList } from "@/components/welcome/folder-list"
import { FolderActions } from "@/components/welcome/folder-actions"
import { SoftwareInfo } from "@/components/welcome/software-info"
import { Button } from "@/components/ui/button"
import { AppToaster } from "@/components/ui/app-toaster"
import { resolveWelcomeError } from "@/components/welcome/error-utils"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { useIsMobile } from "@/hooks/use-mobile"

export function WelcomeScreen() {
  const t = useTranslations("WelcomePage")
  const [history, setHistory] = useState<FolderHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const isMobile = useIsMobile()
  const { shortcuts } = useShortcutSettings()

  const handleOpenSettings = useCallback(() => {
    openSettingsWindow().catch((err) => {
      console.error("[WelcomeScreen] failed to open settings:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.openSettingsFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    })
  }, [t])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchShortcutEvent(e, shortcuts.open_settings)) {
        e.preventDefault()
        handleOpenSettings()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [shortcuts, handleOpenSettings])

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await loadFolderHistory())
    } catch (err) {
      console.error("[WelcomeScreen] failed to load folder history:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.loadFolderHistoryFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
      setHistory([])
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    refreshHistory()
  }, [refreshHistory])

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background text-foreground">
      <AppTitleBar
        center={
          <span className="text-sm font-bold tracking-tight">{t("title")}</span>
        }
        right={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:text-foreground/80"
            onClick={handleOpenSettings}
            title={t("openSettings")}
            aria-label={t("openSettings")}
            type="button"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        }
      />

      <div
        className={
          isMobile
            ? "flex-1 flex flex-col overflow-hidden"
            : "flex-1 flex overflow-hidden"
        }
      >
        <div
          className={
            isMobile
              ? "shrink-0 flex flex-col border-b"
              : "w-60 shrink-0 flex flex-col border-r"
          }
        >
          <SoftwareInfo />
          <FolderActions />
        </div>
        <FolderList
          history={history}
          loading={loading}
          onRefresh={refreshHistory}
        />
      </div>
      <AppToaster position="bottom-right" closeButton duration={4000} />
    </div>
  )
}
