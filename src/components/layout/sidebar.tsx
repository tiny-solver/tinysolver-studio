"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  FolderPlus,
  FolderTree,
  Plus,
  Rows3,
  Search,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useSidebarContext } from "@/contexts/sidebar-context"
import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "@/components/conversations/sidebar-conversation-list"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import { isDesktop, openFileDialog } from "@/lib/platform"
import {
  loadSidebarViewMode,
  saveSidebarViewMode,
  type SidebarViewMode,
} from "@/lib/sidebar-view-mode-storage"
import { cn } from "@/lib/utils"

export function Sidebar() {
  const t = useTranslations("Folder.sidebar")
  const { activeFolder } = useActiveFolder()
  const { allFolders, conversations, openFolder } = useAppWorkspace()
  const { openNewConversationTab } = useTabContext()
  const { isOpen, toggle } = useSidebarContext()
  const isMobile = useIsMobile()
  const listRef = useRef<SidebarConversationListHandle>(null)

  const [viewMode, setViewMode] = useState<SidebarViewMode>("flat")
  const [searchQuery, setSearchQuery] = useState("")

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setViewMode(loadSidebarViewMode())
  }, [])

  const handleSetViewMode = useCallback((mode: SidebarViewMode) => {
    setViewMode(mode)
    saveSidebarViewMode(mode)
  }, [])

  useEffect(() => {
    const onReveal = (e: Event) => {
      const detail = (e as CustomEvent<{ folderId: number }>).detail
      if (!detail) return
      if (viewMode !== "grouped") {
        setViewMode("grouped")
        saveSidebarViewMode("grouped")
      }
      listRef.current?.revealFolder(detail.folderId)
    }
    window.addEventListener("sidebar:reveal-folder", onReveal)
    return () => {
      window.removeEventListener("sidebar:reveal-folder", onReveal)
    }
  }, [viewMode])

  const handleNewConversation = useCallback(() => {
    if (!activeFolder) return
    openNewConversationTab(activeFolder.id, activeFolder.path)
  }, [activeFolder, openNewConversationTab])

  const handleOpenFolder = useCallback(async () => {
    try {
      if (!isDesktop()) {
        toast.error(t("toasts.openFolderFailed"))
        return
      }
      const result = await openFileDialog({
        directory: true,
        multiple: false,
      })
      if (!result) return
      const selected = Array.isArray(result) ? result[0] : result
      const detail = await openFolder(selected)
      toast.success(t("toasts.folderOpened", { name: detail.name }))
    } catch (err) {
      console.error("[Sidebar] open folder failed:", err)
      toast.error(t("toasts.openFolderFailed"))
    }
  }, [openFolder, t])

  if (!isOpen) return null

  return (
    <aside className="group/sidebar flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none">
      <TooltipProvider>
        <div className="flex items-center justify-between border-b border-border px-3 py-2 gap-2">
          <div className="flex items-center gap-2 min-w-0 text-[11px] text-muted-foreground tabular-nums">
            <span className="truncate">
              {t("statsLabel", {
                folders: allFolders.length,
                convos: conversations.length,
              })}
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 text-muted-foreground"
                onClick={handleOpenFolder}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("openFolder")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-7 pl-6 pr-6 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground rounded-sm p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0 text-muted-foreground",
                  viewMode === "flat" && "bg-accent text-foreground"
                )}
                onClick={() => handleSetViewMode("flat")}
              >
                <Rows3 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("viewFlat")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-7 w-7 shrink-0 text-muted-foreground",
                  viewMode === "grouped" && "bg-accent text-foreground"
                )}
                onClick={() => handleSetViewMode("grouped")}
              >
                <FolderTree className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("viewGrouped")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex items-center justify-between border-b border-border px-2 h-7">
          <h2 className="text-xs font-bold text-muted-foreground truncate">
            {t("title")}
          </h2>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/sidebar:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={() => listRef.current?.scrollToActive()}
              title={t("locateActiveConversation")}
            >
              <Crosshair className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={() => listRef.current?.expandAll()}
              title={t("expandAllGroups")}
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={() => listRef.current?.collapseAll()}
              title={t("collapseAllGroups")}
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              onClick={handleNewConversation}
              disabled={!activeFolder}
              title={t("newConversation")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </TooltipProvider>

      {/* On mobile, clicking a conversation card auto-closes the Sheet */}
      <div
        className="flex flex-col flex-1 min-h-0 overflow-hidden"
        onClick={
          isMobile
            ? (e) => {
                const target = e.target as HTMLElement
                if (target.closest("[data-conversation-id]")) {
                  toggle()
                }
              }
            : undefined
        }
      >
        <SidebarConversationList
          ref={listRef}
          viewMode={viewMode}
          searchQuery={searchQuery}
        />
      </div>
    </aside>
  )
}
