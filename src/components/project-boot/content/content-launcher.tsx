"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { closeCurrentWindow } from "@/lib/platform"
import {
  createContentProject,
  listContentTemplates,
  openFolderInWorkspace,
} from "@/lib/api"
import {
  CONTENT_OUTPUT_KINDS,
  type ContentOutputKind,
  type ContentTemplate,
} from "@/lib/types"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { DirectoryPathInput } from "@/components/shared/directory-path-input"

/**
 * "New content project" launcher: one folder holding a story bible and every
 * output made from it (game / webtoon / instatoon / novel / video). The
 * backend scaffolds the layout and writes `codeg-project.json` plus the
 * agent-facing rules; this form only collects name, location, template, and
 * which outputs to start with.
 */
export function ContentLauncher() {
  const t = useTranslations("ProjectBoot")

  const [templates, setTemplates] = useState<ContentTemplate[] | null>(null)
  const [projectName, setProjectName] = useState("my-story")
  const [saveDirectory, setSaveDirectory] = useState("")
  const [templateId, setTemplateId] = useState<string>("")
  const [outputs, setOutputs] = useState<Set<ContentOutputKind>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listContentTemplates()
      .then((list) => {
        if (cancelled) return
        setTemplates(list)
        const first = list[0]
        if (first) {
          setTemplateId(first.id)
          setOutputs(new Set(first.default_outputs))
        }
      })
      .catch((err) => {
        if (cancelled) return
        setTemplates([])
        setError(toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Switching template resets the outputs to that template's defaults — the
  // defaults are the point of a template, and a stale selection from the
  // previous one (a game output on the story template) is the common mistake.
  const handleTemplateChange = useCallback(
    (id: string) => {
      setTemplateId(id)
      const tpl = templates?.find((item) => item.id === id)
      if (tpl) setOutputs(new Set(tpl.default_outputs))
    },
    [templates]
  )

  const toggleOutput = useCallback((kind: ContentOutputKind, on: boolean) => {
    setOutputs((prev) => {
      const next = new Set(prev)
      if (on) next.add(kind)
      else next.delete(kind)
      return next
    })
  }, [])

  const handleCreate = async () => {
    setError(null)
    setCreating(true)
    try {
      const projectPath = await createContentProject({
        projectName: projectName.trim(),
        targetDir: saveDirectory,
        template: templateId,
        outputs: CONTENT_OUTPUT_KINDS.filter((kind) => outputs.has(kind)),
      })
      toast.success(t("toasts.createSuccess"))
      // Same hand-off as the other launchers: the backend upserts the folder
      // and broadcasts it to the workspace; a failure there is not a creation
      // failure, so only warn.
      try {
        await openFolderInWorkspace(projectPath)
        await closeCurrentWindow()
      } catch (handoffErr) {
        console.error(
          "[ContentLauncher] failed to hand project off to workspace:",
          handoffErr
        )
        toast.warning(t("toasts.openWorkspaceFailed"), {
          description: projectPath,
        })
      }
    } catch (err) {
      const appErr = extractAppCommandError(err)
      const message =
        appErr?.code === "already_exists"
          ? t("errors.directoryExists")
          : toErrorMessage(err)
      setError(message)
      toast.error(t("toasts.createFailed"), { description: message })
    } finally {
      setCreating(false)
    }
  }

  const selectedTemplate = templates?.find((item) => item.id === templateId)
  const canCreate =
    projectName.trim().length > 0 &&
    saveDirectory.trim().length > 0 &&
    !!selectedTemplate &&
    outputs.size > 0

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-muted-foreground" />
              <h3 className="text-lg font-semibold">{t("content.title")}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("content.subtitle")}
            </p>
          </div>

          <Separator />

          <div className="space-y-4">
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
              <Label>{t("createDialog.saveDirectory")}</Label>
              <DirectoryPathInput
                value={saveDirectory}
                onValueChange={setSaveDirectory}
                placeholder={t("createDialog.saveDirectoryPlaceholder")}
                disabled={creating}
                browseLabel={t("createDialog.browseDirectory")}
              />
              {saveDirectory && projectName.trim() && (
                <p className="text-xs text-muted-foreground">
                  {t("createDialog.projectPath", {
                    path: joinFsPath(saveDirectory, projectName.trim()),
                  })}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t("content.template")}</Label>
              {templates === null ? (
                <div className="flex h-8 items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("content.loadingTemplates")}
                </div>
              ) : (
                <RadioGroup
                  value={templateId}
                  onValueChange={handleTemplateChange}
                  disabled={creating}
                  className="grid grid-cols-2 gap-2"
                >
                  {templates.map((tpl) => (
                    <FieldLabel key={tpl.id} htmlFor={`tpl-${tpl.id}`}>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>
                            {t(
                              `content.templates.${tpl.label_key}` as Parameters<
                                typeof t
                              >[0]
                            )}
                          </FieldTitle>
                          <FieldDescription>
                            {t(
                              `content.templates.${tpl.label_key}Desc` as Parameters<
                                typeof t
                              >[0]
                            )}
                          </FieldDescription>
                        </FieldContent>
                        <RadioGroupItem value={tpl.id} id={`tpl-${tpl.id}`} />
                      </Field>
                    </FieldLabel>
                  ))}
                </RadioGroup>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t("content.outputs")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("content.outputsHint")}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CONTENT_OUTPUT_KINDS.map((kind) => {
                  const id = `out-${kind}`
                  return (
                    <label
                      key={kind}
                      htmlFor={id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent/40"
                    >
                      <Checkbox
                        id={id}
                        checked={outputs.has(kind)}
                        onCheckedChange={(v) => toggleOutput(kind, v === true)}
                        disabled={creating}
                      />
                      <span>
                        {t(`content.kinds.${kind}` as Parameters<typeof t>[0])}
                      </span>
                    </label>
                  )
                })}
              </div>
              {selectedTemplate?.engine && outputs.has("game") && (
                <p className="text-xs text-muted-foreground">
                  {t("content.engineHint", {
                    engine: selectedTemplate.engine.id,
                    start: selectedTemplate.engine.start,
                  })}
                </p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground/80">
                {t("content.layoutTitle")}
              </div>
              <pre className="whitespace-pre-wrap font-mono">
                {t("content.layout")}
              </pre>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
        <Button onClick={handleCreate} disabled={!canCreate || creating}>
          {creating && <Loader2 className="size-4 animate-spin" />}
          {t("content.create")}
        </Button>
      </div>
    </div>
  )
}
