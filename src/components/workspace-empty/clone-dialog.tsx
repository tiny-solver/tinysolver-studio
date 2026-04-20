"use client"

import { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { cloneRepository } from "@/lib/api"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useGitCredential } from "@/contexts/git-credential-context"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { FolderOpen, Loader2 } from "lucide-react"
import { resolveCloneError } from "@/components/workspace-empty/error-utils"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"

interface CloneDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CloneDialog({ open: isOpen, onOpenChange }: CloneDialogProps) {
  const t = useTranslations("WelcomePage")
  const { withCredentialRetry } = useGitCredential()
  const { openFolder } = useAppWorkspace()
  const [url, setUrl] = useState("")
  const [targetDir, setTargetDir] = useState("")
  const [cloning, setCloning] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [error, setError] = useState<{
    message: string
    detail: string | null
  } | null>(null)

  const repoName = useMemo(
    () =>
      url
        .replace(/\.git$/, "")
        .split("/")
        .pop() ?? "repo",
    [url]
  )

  const handleBrowse = async () => {
    if (isDesktop()) {
      const selected = await openFileDialog({
        directory: true,
        multiple: false,
      })
      if (selected) {
        setTargetDir(Array.isArray(selected) ? selected[0] : selected)
      }
    } else {
      setBrowserOpen(true)
    }
  }

  const handleClone = async () => {
    if (!url || !targetDir) return

    const fullPath = `${targetDir}/${repoName}`

    setCloning(true)
    setError(null)

    try {
      await withCredentialRetry(
        (creds) => cloneRepository(url, fullPath, creds),
        { remoteUrl: url }
      )
      await openFolder(fullPath)
      onOpenChange(false)
      resetForm()
    } catch (err) {
      const resolvedError = resolveCloneError(err)
      setError({
        message: t(resolvedError.key),
        detail: resolvedError.detail ?? null,
      })
      toast.error(t("toasts.cloneFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    } finally {
      setCloning(false)
    }
  }

  const resetForm = () => {
    setUrl("")
    setTargetDir("")
    setError(null)
  }

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(v) => {
          onOpenChange(v)
          if (!v) resetForm()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("cloneDialog.title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="repo-url">{t("cloneDialog.repositoryUrl")}</Label>
              <Input
                id="repo-url"
                placeholder={t("cloneDialog.repositoryUrlPlaceholder")}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={cloning}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-dir">{t("cloneDialog.directory")}</Label>
              <div className="flex gap-2">
                <Input
                  id="target-dir"
                  placeholder={t("cloneDialog.directoryPlaceholder")}
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  disabled={cloning}
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleBrowse}
                  disabled={cloning}
                  title={t("cloneDialog.browseDirectory")}
                  aria-label={t("cloneDialog.browseDirectory")}
                  type="button"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              {targetDir && url && (
                <p className="text-xs text-muted-foreground">
                  {t("cloneDialog.clonePath", {
                    path: `${targetDir}/${repoName}`,
                  })}
                </p>
              )}
            </div>

            {error && (
              <div className="space-y-1">
                <p className="text-sm text-destructive">{error.message}</p>
                {error.detail && (
                  <p className="text-xs text-muted-foreground">
                    {error.detail}
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={cloning}
              type="button"
            >
              {t("cloneDialog.cancel")}
            </Button>
            <Button
              onClick={handleClone}
              disabled={!url || !targetDir || cloning}
              type="button"
            >
              {cloning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("cloneDialog.clone")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DirectoryBrowserDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={(path) => setTargetDir(path)}
      />
    </>
  )
}
