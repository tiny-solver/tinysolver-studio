"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, FolderOpen } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { openFileDialog } from "@/lib/platform"
import { createShadcnProject, openFolderWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { FRAMEWORK_OPTIONS, PACKAGE_MANAGER_OPTIONS } from "./constants"

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetCode: string
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  presetCode,
}: CreateProjectDialogProps) {
  const t = useTranslations("ProjectBoot")
  const [projectName, setProjectName] = useState("my-app")
  const [framework, setFramework] = useState("next")
  const [packageManager, setPackageManager] = useState("pnpm")
  const [saveDirectory, setSaveDirectory] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleBrowse = async () => {
    const result = await openFileDialog({ directory: true, multiple: false })
    if (!result) return
    const selected = Array.isArray(result) ? result[0] : result
    setSaveDirectory(selected)
  }

  const handleCreate = async () => {
    setError(null)
    setCreating(true)
    try {
      const projectPath = await createShadcnProject({
        projectName,
        template: framework,
        presetCode,
        packageManager,
        targetDir: saveDirectory,
      })
      toast.success(t("toasts.createSuccess"))
      onOpenChange(false)
      resetForm()
      await openFolderWindow(projectPath)
    } catch (err) {
      const message = toErrorMessage(err)
      setError(message)
      toast.error(t("toasts.createFailed"), { description: message })
    } finally {
      setCreating(false)
    }
  }

  const resetForm = () => {
    setProjectName("my-app")
    setFramework("next")
    setPackageManager("pnpm")
    setSaveDirectory("")
    setError(null)
  }

  const canCreate =
    projectName.trim().length > 0 && saveDirectory.trim().length > 0

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) resetForm()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("createDialog.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("createDialog.projectName")}</Label>
            <Input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t("createDialog.projectNamePlaceholder")}
              disabled={creating}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("createDialog.frameworkTemplate")}</Label>
            <Select
              value={framework}
              onValueChange={setFramework}
              disabled={creating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FRAMEWORK_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("createDialog.packageManager")}</Label>
            <Select
              value={packageManager}
              onValueChange={setPackageManager}
              disabled={creating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PACKAGE_MANAGER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("createDialog.saveDirectory")}</Label>
            <div className="flex gap-2">
              <Input
                value={saveDirectory}
                onChange={(e) => setSaveDirectory(e.target.value)}
                placeholder={t("createDialog.saveDirectoryPlaceholder")}
                disabled={creating}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBrowse}
                disabled={creating}
                type="button"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {t("createDialog.cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate || creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {creating ? t("createDialog.creating") : t("createDialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
