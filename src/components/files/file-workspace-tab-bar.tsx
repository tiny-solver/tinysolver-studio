"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Reorder } from "motion/react"
import {
  Code,
  Eye,
  ExternalLink,
  FileText,
  GitCompare,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { openPath } from "@/lib/platform"
import { isHtmlPreviewable } from "@/lib/language-detect"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer"
import { useIsMobile } from "@/hooks/use-mobile"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export function FileWorkspaceTabBar({
  embedded = false,
}: {
  embedded?: boolean
} = {}) {
  const t = useTranslations("Folder.fileWorkspace")
  const { mode, activePane, filesMaximized } = useWorkspaceView()
  const { fileTabs, activeFileTabId, previewFileTabIds } =
    useWorkspaceFileTabs()
  const {
    switchFileTab,
    closeFileTab,
    closeOtherFileTabs,
    closeAllFileTabs,
    reorderFileTabs,
    toggleFileTabPreview,
    toggleFilesMaximized,
  } = useWorkspaceActions()
  const { shortcuts } = useShortcutSettings()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const isMobile = useIsMobile()
  const [isHovered, setIsHovered] = useState(false)
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.deltaY !== 0 && scrollRef.current) {
      e.preventDefault()
      scrollRef.current.scrollLeft += e.deltaY
    }
  }, [])

  useEffect(() => {
    if (!activeFileTabId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-file-tab-id="${activeFileTabId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeFileTabId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While maximized only the files pane is interactive, so route shortcuts
      // here regardless of the user's last-clicked pane.
      const shouldHandleShortcut =
        mode === "fusion" && (activePane === "files" || filesMaximized)
      if (!shouldHandleShortcut) return
      if (matchShortcutEvent(event, shortcuts.close_all_file_tabs)) {
        event.preventDefault()
        closeAllFileTabs()
        return
      }
      if (!matchShortcutEvent(event, shortcuts.close_current_tab)) return

      if (!activeFileTabId) return
      event.preventDefault()
      closeFileTab(activeFileTabId)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [
    activeFileTabId,
    closeAllFileTabs,
    closeFileTab,
    mode,
    activePane,
    filesMaximized,
    shortcuts.close_all_file_tabs,
    shortcuts.close_current_tab,
  ])

  const handleReorder = useCallback(
    (nextTabs: FileWorkspaceTab[]) => {
      if (isCoarsePointer && !touchSortingTabId) return
      reorderFileTabs(nextTabs)
    },
    [isCoarsePointer, reorderFileTabs, touchSortingTabId]
  )

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  const activeTab = fileTabs.find((tab) => tab.id === activeFileTabId)
  const canPreview =
    activeTab?.kind === "file" &&
    (activeTab.language === "markdown" || isHtmlPreviewable(activeTab.path))
  const canOpenInBrowser =
    activeTab?.kind === "file" && isHtmlPreviewable(activeTab.path)
  const isPreviewActive =
    canPreview && activeFileTabId
      ? previewFileTabIds.has(activeFileTabId)
      : false

  // Embedded in the title bar: fill its height and let the bar own the bottom
  // border. Standalone (mobile panel row): keep the h-10 row + border.
  const rowHeight = embedded ? "h-full" : "h-10"
  const rowBorder = embedded ? "" : "border-b border-border"

  if (fileTabs.length === 0) {
    // In the title bar an empty file workspace shows nothing (only the
    // conversation tabs remain); the standalone panel row keeps its label.
    if (embedded) return null
    return (
      <div className="h-10 px-3 flex items-center border-b border-border text-xs text-muted-foreground">
        {t("files")}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "flex items-stretch",
        // Embedded: fill the resizable panel that bounds our width in the title
        // bar. Standalone: intrinsic size in the mobile panel row.
        embedded && "h-full w-full min-w-0"
      )}
    >
      <Reorder.Group
        as="div"
        ref={scrollRef}
        role="tablist"
        axis="x"
        values={fileTabs}
        onReorder={handleReorder}
        // Embedded tabs shrink to fit (no overflow), so wheel-to-scroll is both
        // unnecessary and wrong — `overflow-hidden` still scrolls programmatically.
        onWheel={embedded ? undefined : handleWheel}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={cn(
          "pt-1.5 px-1.5 min-w-0 flex items-stretch gap-1.5",
          // Standalone row fills its container so the trailing action buttons
          // sit flush right; embedded sizes to content so the wrapper's drag
          // spacer claims the leftover row.
          !embedded && "flex-1",
          rowHeight,
          rowBorder,
          // Embedded: no scrollbar — tabs shrink browser-style to share the
          // panel (see FileWorkspaceTabItem `embedded`). Standalone: horizontal
          // scroll with a hover scrollbar (mobile panel row).
          embedded
            ? "overflow-hidden pb-1.5"
            : [
                "overflow-x-scroll",
                isHovered
                  ? [
                      "pb-0.5",
                      "[&::-webkit-scrollbar]:h-1",
                      "[&::-webkit-scrollbar-track]:bg-transparent",
                      "[&::-webkit-scrollbar-thumb]:rounded-full",
                      "[&::-webkit-scrollbar-thumb]:bg-border",
                    ]
                  : ["pb-1.5", "[&::-webkit-scrollbar]:h-0"],
              ]
        )}
      >
        {fileTabs.map((tab) => (
          <FileWorkspaceTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeFileTabId}
            embedded={embedded}
            closeLabel={t("closeFileTab")}
            closeText={t("close")}
            closeOthersText={t("closeOthers")}
            closeAllText={t("closeAll")}
            isCoarsePointer={isCoarsePointer}
            isTouchSorting={touchSortingTabId === tab.id}
            onSwitch={switchFileTab}
            onClose={closeFileTab}
            onCloseOthers={closeOtherFileTabs}
            onCloseAll={closeAllFileTabs}
            onTouchSortingStart={setTouchSortingTabId}
            onTouchSortingEnd={handleTouchSortingEnd}
          />
        ))}
      </Reorder.Group>
      {/* Title-bar strip: fill the leftover panel width with a window-drag
          region so a lightly-tabbed file bar can still move the window. */}
      {embedded && (
        <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
      )}
      {/* Trailing file-action buttons render only in the standalone (mobile
          panel) row. In the desktop title bar (embedded) they live in the file
          detail header instead (FileWorkspaceHeader). */}
      {!embedded && canPreview && activeFileTabId && (
        <button
          type="button"
          onClick={() => toggleFileTabPreview(activeFileTabId)}
          className={cn(
            "shrink-0 flex items-center justify-center w-10 hover:bg-primary/8 transition-colors",
            rowBorder,
            isPreviewActive && "text-primary"
          )}
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
      {!embedded && canOpenInBrowser && activeTab?.path && (
        <button
          type="button"
          onClick={() => {
            // File tab paths are absolute — hand the path straight to the OS.
            openPath(activeTab.path as string).catch(() => {})
          }}
          className={cn(
            "shrink-0 flex items-center justify-center w-10 hover:bg-primary/8 transition-colors",
            rowBorder
          )}
          aria-label={t("preview")}
          title={t("preview")}
        >
          <ExternalLink className="h-4 w-4" />
        </button>
      )}
      {!embedded && !isMobile && mode === "fusion" && (
        <button
          type="button"
          onClick={toggleFilesMaximized}
          className={cn(
            "shrink-0 flex items-center justify-center w-10 hover:bg-primary/8 transition-colors",
            rowBorder,
            filesMaximized && "text-primary"
          )}
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
  )
}

interface FileWorkspaceTabItemProps {
  tab: FileWorkspaceTab
  active: boolean
  embedded: boolean
  closeLabel: string
  closeText: string
  closeOthersText: string
  closeAllText: string
  isCoarsePointer: boolean
  isTouchSorting: boolean
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onTouchSortingStart: (tabId: string) => void
  onTouchSortingEnd: () => void
}

const FileWorkspaceTabItem = memo(function FileWorkspaceTabItem({
  tab,
  active,
  embedded,
  closeLabel,
  closeText,
  closeOthersText,
  closeAllText,
  isCoarsePointer,
  isTouchSorting,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTouchSortingStart,
  onTouchSortingEnd,
}: FileWorkspaceTabItemProps) {
  const isDiff = tab.kind === "diff" || tab.kind === "rich-diff"
  const isDirty = tab.kind === "file" && Boolean(tab.isDirty)

  const handleLongPressStart = useCallback(
    () => onTouchSortingStart(tab.id),
    [onTouchSortingStart, tab.id]
  )

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer,
    onStart: handleLongPressStart,
    onEnd: onTouchSortingEnd,
  })

  const handleSwitch = useCallback(() => {
    onSwitch(tab.id)
  }, [onSwitch, tab.id])

  const whileDrag = useMemo(() => ({ scale: 1.03 }), [])

  return (
    <Reorder.Item
      as="div"
      value={tab}
      data-file-tab-id={tab.id}
      drag="x"
      dragControls={dragControls}
      dragListener={!isCoarsePointer}
      whileDrag={whileDrag}
      {...gestureHandlers}
      className={cn(
        "rounded-full cursor-grab active:cursor-grabbing",
        // Embedded: share the row width (browser-style shrink). `grow-0 basis-48`
        // keeps a few tabs at their natural width (leftover row stays a
        // window-drag region) while still shrinking together once full;
        // `overflow-hidden` clips the padded inner row so a shrunken tab can't
        // paint/click over its neighbor. Standalone: intrinsic width (scroll row).
        embedded
          ? "min-w-0 grow-0 shrink basis-48 overflow-hidden"
          : "shrink-0",
        isTouchSorting && "z-50 opacity-90 shadow-md ring-1 ring-primary/25"
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isTouchSorting}>
          <div
            role="tab"
            aria-selected={active}
            onClick={handleSwitch}
            onMouseDown={(event) =>
              handleMiddleClickClose(event, () => onClose(tab.id))
            }
            className={cn(
              "group/filetab relative flex items-center h-full gap-1.5 px-3 text-xs rounded-full",
              "cursor-pointer select-none hover:bg-primary/8 transition-colors",
              embedded ? "w-full min-w-0" : "shrink-0",
              active ? "bg-primary/10 text-foreground" : "text-muted-foreground"
            )}
            title={tab.description ?? tab.title}
          >
            {isDiff ? (
              <GitCompare className="h-3.5 w-3.5" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            <span
              className={cn(
                "truncate",
                embedded ? "min-w-0 flex-1" : "max-w-[180px]"
              )}
            >
              {tab.title}
              {isDirty ? " *" : ""}
            </span>
            <button
              type="button"
              className={cn(
                "rounded-full p-0.5 hover:bg-muted",
                active
                  ? "opacity-100"
                  : "opacity-0 group-hover/filetab:opacity-100"
              )}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              aria-label={closeLabel}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onClose(tab.id)}>
            {closeText}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseOthers(tab.id)}>
            {closeOthersText}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCloseAll}>
            {closeAllText}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  )
})
