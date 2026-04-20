"use client"

import { useState } from "react"
import { FolderOpen, GitBranch, Rocket } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { openProjectBootWindow } from "@/lib/api"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { CloneDialog } from "./clone-dialog"
import { resolveWelcomeError } from "@/components/workspace-empty/error-utils"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"

export function FolderActions() {
  const t = useTranslations("WelcomePage")
  const { openFolder } = useAppWorkspace()
  const [cloneOpen, setCloneOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  const handleOpen = async () => {
    if (isDesktop()) {
      const result = await openFileDialog({
        directory: true,
        multiple: false,
      })
      if (!result) return
      const selected = Array.isArray(result) ? result[0] : result
      try {
        await openFolder(selected)
      } catch (err) {
        console.error("[FolderActions] failed to open folder:", err)
        const resolvedError = resolveWelcomeError(err)
        toast.error(t("toasts.openFolderFailed"), {
          description: resolvedError.detail ?? t(resolvedError.key),
        })
      }
    } else {
      setBrowserOpen(true)
    }
  }

  const handleBrowserSelect = async (path: string) => {
    try {
      await openFolder(path)
    } catch (err) {
      console.error("[FolderActions] failed to open folder:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.openFolderFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    }
  }

  return (
    <>
      <div className="w-full flex flex-col gap-1 px-3">
        <Button
          variant="ghost"
          className="justify-start gap-2 h-9"
          onClick={handleOpen}
          type="button"
        >
          <FolderOpen className="h-4 w-4" />
          {t("openFolder")}
        </Button>
        <Button
          variant="ghost"
          className="justify-start gap-2 h-9"
          onClick={() => setCloneOpen(true)}
          type="button"
        >
          <GitBranch className="h-4 w-4" />
          {t("cloneRepository")}
        </Button>

        <Button
          variant="ghost"
          className="justify-start gap-2 h-9"
          onClick={async () => {
            try {
              await openProjectBootWindow("welcome")
            } catch (err) {
              console.error("[FolderActions] failed to open project boot:", err)
              toast.error(t("toasts.openProjectBootFailed"))
            }
          }}
          type="button"
        >
          <Rocket className="h-4 w-4" />
          {t("projectBoot")}
        </Button>

        <CloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      </div>

      <DirectoryBrowserDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={handleBrowserSelect}
      />
    </>
  )
}
