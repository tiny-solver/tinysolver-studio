"use client"

import {
  Code,
  ExternalLink,
  Eye,
  FileText,
  GitCompare,
  Maximize2,
  Minimize2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { openPath } from "@/lib/platform"
import { isHtmlPreviewable } from "@/lib/language-detect"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { cn } from "@/lib/utils"

/**
 * Desktop file-detail header: the active file's name on the left, its file-type
 * actions on the right — markdown/html preview⇄source toggle, open-in-browser
 * (html), and maximize/restore. These moved out of the file tab strip
 * (`FileWorkspaceTabBar`) when the tabs were relocated into the title bar, so
 * the per-file operations now sit with the file content. Rendered only on
 * desktop (`WorkspaceContent`); the mobile panel row keeps these buttons in its
 * own tab bar. Sits above every `FileWorkspacePanel` render branch
 * (editor / preview / diff / image / office), so it wraps them all uniformly.
 */
export function FileWorkspaceHeader() {
  const t = useTranslations("Folder.fileWorkspace")
  const { activeFileTab, activeFileTabId, previewFileTabIds } =
    useWorkspaceFileTabs()
  const { toggleFileTabPreview, toggleFilesMaximized } = useWorkspaceActions()
  const { mode, filesMaximized } = useWorkspaceView()

  if (!activeFileTab) return null

  const isDiff =
    activeFileTab.kind === "diff" || activeFileTab.kind === "rich-diff"
  const isDirty =
    activeFileTab.kind === "file" && Boolean(activeFileTab.isDirty)
  // Mirror the gating the file tab strip used (file-workspace-tab-bar.tsx):
  // preview toggle for markdown/html, browser-open for html.
  const canPreview =
    activeFileTab.kind === "file" &&
    (activeFileTab.language === "markdown" ||
      isHtmlPreviewable(activeFileTab.path))
  const canOpenInBrowser =
    activeFileTab.kind === "file" && isHtmlPreviewable(activeFileTab.path)
  const isPreviewActive =
    canPreview && activeFileTabId
      ? previewFileTabIds.has(activeFileTabId)
      : false

  const actionBtn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-primary/8 transition-colors"

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
        {isDiff ? (
          <GitCompare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className="truncate text-foreground/90"
          title={activeFileTab.description ?? activeFileTab.title}
        >
          {activeFileTab.title}
          {isDirty ? " *" : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {canPreview && activeFileTabId && (
          <button
            type="button"
            onClick={() => toggleFileTabPreview(activeFileTabId)}
            className={cn(actionBtn, isPreviewActive && "text-primary")}
            aria-label={isPreviewActive ? t("editSource") : t("preview")}
            title={isPreviewActive ? t("editSource") : t("preview")}
          >
            {isPreviewActive ? (
              <Code className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        )}
        {canOpenInBrowser && activeFileTab.path && (
          <button
            type="button"
            onClick={() => {
              // File tab paths are absolute — hand the path straight to the OS.
              openPath(activeFileTab.path as string).catch(() => {})
            }}
            className={actionBtn}
            aria-label={t("preview")}
            title={t("preview")}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        )}
        {mode === "fusion" && (
          <button
            type="button"
            onClick={toggleFilesMaximized}
            className={cn(actionBtn, filesMaximized && "text-primary")}
            aria-label={filesMaximized ? t("restore") : t("maximize")}
            aria-pressed={filesMaximized}
            title={filesMaximized ? t("restore") : t("maximize")}
          >
            {filesMaximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </div>
  )
}
