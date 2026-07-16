"use client"

import { memo, useCallback, useMemo, useRef } from "react"
import { Reorder } from "motion/react"
import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import type { ConversationStatus } from "@/lib/types"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"
import type { TabItem as TabItemData } from "@/contexts/tab-context"

interface TabItemProps {
  tab: TabItemData
  isActive: boolean
  isTileMode: boolean
  /** Browser-style shrink: fill/shrink to share the row width instead of a
   *  fixed intrinsic size (title-bar embedded strips). Off = mobile scroll row. */
  embedded?: boolean
  folderName: string | null
  folderBranch: string | null
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onPin: (tabId: string) => void
  onToggleTile: () => void
  isCoarsePointer: boolean
  isTouchSorting: boolean
  onTouchSortingStart: (tabId: string) => void
  onTouchSortingEnd: () => void
}

export const TabItem = memo(function TabItem({
  tab,
  isActive,
  isTileMode,
  embedded = false,
  folderName,
  folderBranch,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseAll,
  onPin,
  onToggleTile,
  isCoarsePointer,
  isTouchSorting,
  onTouchSortingStart,
  onTouchSortingEnd,
}: TabItemProps) {
  const t = useTranslations("Folder.tabs")
  const itemRef = useRef<HTMLDivElement>(null)

  const resolvedFolderName = folderName ?? String(tab.folderId)
  const tooltip = folderBranch
    ? `${resolvedFolderName} · ${folderBranch}  —  ${tab.title}`
    : `${resolvedFolderName}  —  ${tab.title}`

  const clearResidualStyles = useCallback(() => {
    const el = itemRef.current
    if (!el) return
    el.style.transform = ""
    el.style.zIndex = ""
    el.style.position = ""
    el.style.userSelect = ""
  }, [])

  const handleLongPressStart = useCallback(
    () => onTouchSortingStart(tab.id),
    [onTouchSortingStart, tab.id]
  )

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer,
    onStart: handleLongPressStart,
    onEnd: onTouchSortingEnd,
    onDragSettle: clearResidualStyles,
  })

  const handleClick = useCallback(() => {
    onSwitch(tab.id)
  }, [onSwitch, tab.id])

  const handleDoubleClick = useCallback(() => {
    if (!tab.isPinned) {
      onPin(tab.id)
    }
  }, [onPin, tab.id, tab.isPinned])

  const handleClose = useCallback(() => {
    onClose(tab.id)
  }, [onClose, tab.id])

  const handleCloseOthers = useCallback(() => {
    onCloseOthers(tab.id)
  }, [onCloseOthers, tab.id])

  const whileDrag = useMemo(() => ({ scale: 1.03 }), [])

  return (
    <Reorder.Item
      ref={itemRef}
      as="div"
      value={tab}
      data-tab-id={tab.id}
      drag="x"
      dragControls={dragControls}
      dragListener={!isCoarsePointer}
      whileDrag={whileDrag}
      {...gestureHandlers}
      onLayoutAnimationComplete={clearResidualStyles}
      className={cn(
        "rounded-full cursor-grab active:cursor-grabbing",
        // Embedded: share the row via flex so tabs shrink uniformly (no
        // scrollbar). `grow-0 basis-48` means a few tabs sit at their natural
        // width (not stretched) — the leftover row is a window-drag region — yet
        // still shrink together once the row fills. `overflow-hidden` clips the
        // padded inner row to the (possibly tiny) item box so a shrunken tab's
        // icon/close button can't paint or take clicks over its neighbor.
        // Standalone: intrinsic size + horizontal scroll (mobile row).
        embedded
          ? "min-w-0 grow-0 shrink basis-48 overflow-hidden"
          : "shrink-0",
        !isCoarsePointer && "active:opacity-90 active:shadow-md active:z-50",
        isTouchSorting && "z-50 opacity-90 shadow-md ring-1 ring-primary/25"
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isTouchSorting}>
          <div
            role="tab"
            aria-selected={isActive}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onMouseDown={(event) => handleMiddleClickClose(event, handleClose)}
            className={cn(
              "group/tab relative flex items-center h-full gap-1.5 px-3 text-xs rounded-full",
              "cursor-pointer select-none",
              // Embedded: fill + allow shrink so the label truncates as the row
              // tightens. Standalone: intrinsic width (scroll row).
              embedded ? "w-full min-w-0" : "shrink-0",
              "hover:bg-primary/8 transition-colors",
              isActive
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground"
            )}
          >
            <ConversationStatusDot
              status={tab.status as ConversationStatus | undefined}
            />
            <span
              className={cn(
                "truncate",
                // Embedded: grow + shrink so the title truncates as the tab
                // tightens. Standalone: fixed cap in the scroll row.
                embedded ? "min-w-0 flex-1" : "max-w-[140px]",
                !tab.isPinned && "[font-style:oblique]"
              )}
              title={tooltip}
            >
              {tab.title}
            </span>
            <button
              type="button"
              className={cn(
                "rounded-full p-0.5 hover:bg-muted",
                isActive
                  ? "opacity-100"
                  : "opacity-0 group-hover/tab:opacity-100"
              )}
              onClick={(event) => {
                event.stopPropagation()
                handleClose()
              }}
              aria-label={t("closeConversationTab")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleClose}>{t("close")}</ContextMenuItem>
          <ContextMenuItem onSelect={handleCloseOthers}>
            {t("closeOthers")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onToggleTile}>
            {isTileMode ? t("untileDisplay") : t("tileDisplay")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCloseAll}>
            {t("closeAll")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  )
})
