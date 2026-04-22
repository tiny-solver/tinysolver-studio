"use client"

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import {
  ChevronRight,
  Download,
  FolderOpen,
  GitBranch,
  ListChecks,
  Loader2,
  Plus,
  Rocket,
  XCircle,
} from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useTaskContext } from "@/contexts/task-context"
import { useZoomLevel } from "@/hooks/use-appearance"
import {
  importLocalConversations,
  openProjectBootWindow,
  updateConversationTitle,
  updateConversationStatus,
  deleteConversation,
} from "@/lib/api"
import { isDesktop, openFileDialog } from "@/lib/platform"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import {
  loadFolderExpanded,
  saveFolderExpanded,
} from "@/lib/sidebar-view-mode-storage"
import { SidebarConversationCard } from "./sidebar-conversation-card"
import { ConversationManageDialog } from "./conversation-manage-dialog"
import { CloneDialog } from "@/components/layout/clone-dialog"
import { DirectoryBrowserDialog } from "@/components/shared/directory-browser-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
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
import { cn } from "@/lib/utils"

function parseTimestamp(value: string): number {
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function compareByUpdatedAtDesc(
  left: DbConversationSummary,
  right: DbConversationSummary
): number {
  const updatedDiff =
    parseTimestamp(right.updated_at) - parseTimestamp(left.updated_at)
  if (updatedDiff !== 0) return updatedDiff

  const createdDiff =
    parseTimestamp(right.created_at) - parseTimestamp(left.created_at)
  if (createdDiff !== 0) return createdDiff

  return right.id - left.id
}

function formatRelative(iso: string): string {
  const ts = parseTimestamp(iso)
  if (!ts) return ""
  const diff = Math.max(0, Date.now() - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}

type FlatItem =
  | {
      type: "folder_header"
      folderId: number
      folderName: string
      count: number
      expanded: boolean
    }
  | { type: "conversation"; conversation: DbConversationSummary }

const CARD_HEIGHT_REM = 2

const FolderHeader = memo(function FolderHeader({
  folderId,
  folderName,
  count,
  expanded,
  importing,
  onToggle,
  onRemoveFromWorkspace,
  onNewConversation,
  onImport,
  onManageConversations,
  t,
}: {
  folderId: number
  folderName: string
  count: number
  expanded: boolean
  importing: boolean
  onToggle: (folderId: number) => void
  onRemoveFromWorkspace: (folderId: number) => void
  onNewConversation: (folderId: number) => void
  onImport: (folderId: number) => void
  onManageConversations: (folderId: number) => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative h-[2rem]">
          <div
            className={cn(
              "flex h-[1.9375rem] w-full items-center",
              "rounded-[0.4375rem] border",
              "transition-[background-color,color,border-color] duration-150",
              expanded
                ? "bg-sidebar-primary/15 border-sidebar-primary/25"
                : "border-transparent hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_2%)]"
            )}
          >
            <button
              data-folder-id={folderId}
              onClick={() => onToggle(folderId)}
              className={cn(
                "flex h-full min-w-0 flex-1 items-center gap-[0.5rem] px-2 cursor-pointer outline-none",
                "text-sidebar-foreground"
              )}
            >
              <span
                className={cn(
                  "flex h-[0.75rem] w-[0.75rem] shrink-0 items-center justify-center text-muted-foreground/75",
                  "transition-transform duration-[180ms] [transition-timing-function:cubic-bezier(.3,.7,.3,1)]",
                  expanded ? "rotate-90" : "rotate-0"
                )}
              >
                <ChevronRight className="h-[0.625rem] w-[0.625rem]" />
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-[0.375rem]">
                <span
                  className={cn(
                    "min-w-0 flex-shrink truncate text-left text-[0.875rem] font-semibold tracking-[-0.00625rem]",
                    "transition-colors duration-150",
                    expanded && "text-sidebar-primary"
                  )}
                >
                  {folderName}
                </span>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center justify-center",
                    "h-[0.9375rem] min-w-[1rem] rounded-[0.3125rem] px-[0.25rem]",
                    "text-[0.625rem] font-semibold leading-none tabular-nums",
                    "transition-colors duration-150",
                    expanded
                      ? "bg-sidebar-primary/20 text-sidebar-primary"
                      : "bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_6%)] text-muted-foreground/80"
                  )}
                >
                  {count}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onNewConversation(folderId)
              }}
              title={t("newConversation")}
              aria-label={t("newConversation")}
              className={cn(
                "mr-[0.25rem] flex h-[1.25rem] w-[1.25rem] shrink-0 items-center justify-center",
                "rounded-[0.25rem] cursor-pointer outline-none text-muted-foreground/80",
                "transition-colors duration-150",
                expanded
                  ? "hover:text-sidebar-primary"
                  : "hover:text-sidebar-foreground"
              )}
            >
              <Plus className="h-[0.75rem] w-[0.75rem]" />
            </button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onNewConversation(folderId)}>
          <Plus className="h-4 w-4" />
          {t("newConversation")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={importing}
          onSelect={() => onImport(folderId)}
        >
          <Download className="h-4 w-4" />
          {importing ? t("importing") : t("importLocalSessions")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onManageConversations(folderId)}>
          <ListChecks className="h-4 w-4" />
          {t("folderHeaderMenu.manageConversations")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onRemoveFromWorkspace(folderId)}
        >
          <XCircle className="h-4 w-4" />
          {t("folderHeaderMenu.removeFromWorkspace")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

export interface SidebarConversationListHandle {
  scrollToActive: () => void
  expandAll: () => void
  collapseAll: () => void
}

export interface SidebarConversationListProps {
  showCompleted?: boolean
}

export function SidebarConversationList({
  ref,
  showCompleted = true,
}: SidebarConversationListProps & {
  ref?: Ref<SidebarConversationListHandle>
}) {
  const t = useTranslations("Folder.sidebar")
  const tCommon = useTranslations("Folder.common")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const { zoomLevel } = useZoomLevel()
  const safeZoomLevel =
    typeof zoomLevel === "number" && Number.isFinite(zoomLevel) && zoomLevel > 0
      ? zoomLevel
      : 100
  const cardHeightPx = Math.max(
    1,
    Math.round((CARD_HEIGHT_REM * 16 * safeZoomLevel) / 100)
  )
  const {
    folders,
    allFolders,
    conversations,
    conversationsLoading: loading,
    conversationsError: error,
    refreshConversations,
    updateConversationLocal,
    removeFolderFromWorkspace,
    openFolder,
  } = useAppWorkspace()
  const refreshing = loading
  const { activeFolder } = useActiveFolder()

  const {
    openTab,
    closeConversationTab,
    closeTabsByFolder,
    openNewConversationTab,
    activeTabId,
    tabs,
  } = useTabContext()
  const { addTask, updateTask } = useTaskContext()

  const folderIndex = useMemo(() => {
    const map = new Map<number, { name: string; path: string }>()
    for (const f of allFolders) map.set(f.id, { name: f.name, path: f.path })
    return map
  }, [allFolders])

  const selectedConversation = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab || activeTab.conversationId == null) return null
    return {
      id: activeTab.conversationId,
      agentType: activeTab.agentType,
    }
  }, [tabs, activeTabId])

  const [importing, setImporting] = useState(false)
  const [folderExpanded, setFolderExpanded] = useState<Record<number, boolean>>(
    {}
  )
  const [scrollOffset, setScrollOffset] = useState(0)
  const [removeConfirm, setRemoveConfirm] = useState<{
    folderId: number
    folderName: string
  } | null>(null)
  const [manageState, setManageState] = useState<{
    folderId: number
    folderName: string
  } | null>(null)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.

    setFolderExpanded(loadFolderExpanded())
  }, [])

  const scrollToActiveRef = useRef<() => void>(() => {})
  const pendingScrollRef = useRef(false)
  const virtualizerRef = useRef<VirtualizerHandle>(null)

  const filteredConversations = useMemo(() => {
    if (showCompleted) return conversations
    return conversations.filter(
      (c) => c.status !== "completed" && c.status !== "cancelled"
    )
  }, [conversations, showCompleted])

  const byFolder = useMemo(() => {
    const map = new Map<number, DbConversationSummary[]>()
    for (const conv of filteredConversations) {
      const list = map.get(conv.folder_id)
      if (list) list.push(conv)
      else map.set(conv.folder_id, [conv])
    }
    for (const list of map.values()) list.sort(compareByUpdatedAtDesc)
    return map
  }, [filteredConversations])

  const orderedFolderIds = useMemo(() => {
    const seen = new Set<number>()
    const ids: number[] = []
    for (const f of allFolders) {
      if (!seen.has(f.id)) {
        seen.add(f.id)
        ids.push(f.id)
      }
    }
    for (const id of byFolder.keys()) {
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  }, [allFolders, byFolder])

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = []
    for (const folderId of orderedFolderIds) {
      const list = byFolder.get(folderId) ?? []
      const folderName = folderIndex.get(folderId)?.name ?? String(folderId)
      const expanded = folderExpanded[folderId] ?? true
      items.push({
        type: "folder_header",
        folderId,
        folderName,
        count: list.length,
        expanded,
      })
      if (!expanded) continue
      for (const conv of list) {
        items.push({ type: "conversation", conversation: conv })
      }
    }
    return items
  }, [orderedFolderIds, byFolder, folderIndex, folderExpanded])

  const stickyState = useMemo<{
    folder: Extract<FlatItem, { type: "folder_header" }> | null
    pushOffset: number
  }>(() => {
    // All items are uniform height (cardHeightPx). Compute offsets from the
    // index directly instead of querying virtua — querying it during render
    // (when flatItems has grown but Virtualizer hasn't re-rendered yet) can
    // poison its internal size cache and produce NaN for total scroll height.
    if (flatItems.length === 0 || cardHeightPx <= 0) {
      return { folder: null, pushOffset: 0 }
    }
    const rawStart = Math.floor(scrollOffset / cardHeightPx)
    const startIdx = Math.max(
      0,
      Math.min(flatItems.length - 1, Number.isFinite(rawStart) ? rawStart : 0)
    )
    let folderIdx = -1
    for (let i = startIdx; i >= 0; i--) {
      if (flatItems[i]?.type === "folder_header") {
        folderIdx = i
        break
      }
    }
    if (folderIdx < 0) {
      return { folder: null, pushOffset: 0 }
    }
    const folder = flatItems[folderIdx] as Extract<
      FlatItem,
      { type: "folder_header" }
    >
    let pushOffset = 0
    for (let i = folderIdx + 1; i < flatItems.length; i++) {
      if (flatItems[i].type === "folder_header") {
        const nextRelativeY = i * cardHeightPx - scrollOffset
        if (nextRelativeY < cardHeightPx) {
          pushOffset = Math.min(0, nextRelativeY - cardHeightPx)
        }
        break
      }
    }
    return { folder, pushOffset }
  }, [scrollOffset, flatItems, cardHeightPx])

  const stickyFolderItem = stickyState.folder

  useImperativeHandle(ref, () => ({
    scrollToActive() {
      scrollToActiveRef.current()
    },
    expandAll() {
      setFolderExpanded((prev) => {
        const next: Record<number, boolean> = { ...prev }
        for (const id of orderedFolderIds) next[id] = true
        saveFolderExpanded(next)
        return next
      })
    },
    collapseAll() {
      setFolderExpanded((prev) => {
        const next: Record<number, boolean> = { ...prev }
        for (const id of orderedFolderIds) next[id] = false
        saveFolderExpanded(next)
        return next
      })
    },
  }))

  useEffect(() => {
    scrollToActiveRef.current = () => {
      if (!selectedConversation) return
      const targetId = selectedConversation.id
      const targetAgent = selectedConversation.agentType
      const conv = conversations.find(
        (c) => c.id === targetId && c.agent_type === targetAgent
      )
      if (!conv) return
      if (!(folderExpanded[conv.folder_id] ?? true)) {
        setFolderExpanded((prev) => {
          const next = { ...prev, [conv.folder_id]: true }
          saveFolderExpanded(next)
          return next
        })
        pendingScrollRef.current = true
        return
      }
      const index = flatItems.findIndex(
        (item) =>
          item.type === "conversation" &&
          item.conversation.id === targetId &&
          item.conversation.agent_type === targetAgent
      )
      if (index >= 0) {
        virtualizerRef.current?.scrollToIndex(index, {
          align: "center",
          smooth: true,
        })
      }
    }

    if (pendingScrollRef.current) {
      pendingScrollRef.current = false
      scrollToActiveRef.current()
    }
  }, [selectedConversation, flatItems, conversations, folderExpanded])

  const toggleFolder = useCallback((folderId: number) => {
    setFolderExpanded((prev) => {
      const next = { ...prev, [folderId]: !(prev[folderId] ?? true) }
      saveFolderExpanded(next)
      return next
    })
  }, [])

  const handleRemoveFolder = useCallback(
    (folderId: number) => {
      const name = folderIndex.get(folderId)?.name ?? String(folderId)
      setRemoveConfirm({ folderId, folderName: name })
    },
    [folderIndex]
  )

  const handleManageConversations = useCallback(
    (folderId: number) => {
      const name = folderIndex.get(folderId)?.name ?? String(folderId)
      setManageState({ folderId, folderName: name })
    },
    [folderIndex]
  )

  const handleRemoveFolderConfirm = useCallback(async () => {
    if (!removeConfirm) return
    const { folderId, folderName } = removeConfirm
    try {
      closeTabsByFolder(folderId)
      await removeFolderFromWorkspace(folderId)
      toast.success(t("toasts.folderRemoved", { name: folderName }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t("toasts.removeFolderFailed", { message: msg }))
    } finally {
      setRemoveConfirm(null)
    }
  }, [removeConfirm, closeTabsByFolder, removeFolderFromWorkspace, t])

  const handleSelect = useCallback(
    (id: number, agentType: string) => {
      const conv = conversations.find(
        (c) => c.id === id && c.agent_type === agentType
      )
      if (!conv) return
      openTab(
        conv.folder_id,
        id,
        agentType as Parameters<typeof openTab>[2],
        false
      )
    },
    [openTab, conversations]
  )

  const handleDoubleClick = useCallback(
    (id: number, agentType: string) => {
      const conv = conversations.find(
        (c) => c.id === id && c.agent_type === agentType
      )
      if (!conv) return
      openTab(
        conv.folder_id,
        id,
        agentType as Parameters<typeof openTab>[2],
        true
      )
    },
    [openTab, conversations]
  )

  const handleRename = useCallback(
    async (id: number, newTitle: string) => {
      await updateConversationTitle(id, newTitle)
      refreshConversations()
    },
    [refreshConversations]
  )

  const handleDelete = useCallback(
    async (id: number, agentType: string) => {
      const conv = conversations.find(
        (c) => c.id === id && c.agent_type === agentType
      )
      await deleteConversation(id)
      if (conv) {
        closeConversationTab(
          conv.folder_id,
          id,
          agentType as Parameters<typeof openTab>[2]
        )
      }
      refreshConversations()
    },
    [closeConversationTab, refreshConversations, conversations]
  )

  const handleStatusChange = useCallback(
    async (id: number, status: ConversationStatus) => {
      updateConversationLocal(id, { status })
      await updateConversationStatus(id, status)
    },
    [updateConversationLocal]
  )

  const handleNewConversation = useCallback(() => {
    if (!activeFolder) return
    openNewConversationTab(activeFolder.id, activeFolder.path)
  }, [activeFolder, openNewConversationTab])

  const handleNewConversationForFolder = useCallback(
    (folderId: number) => {
      const folder = folderIndex.get(folderId)
      if (!folder) return
      openNewConversationTab(folderId, folder.path)
    },
    [folderIndex, openNewConversationTab]
  )

  const handleImportForFolder = useCallback(
    async (folderId: number) => {
      if (importing) return
      setImporting(true)
      const taskId = `import-${folderId}-${Date.now()}`
      addTask(taskId, t("importLocalSessions"))
      updateTask(taskId, { status: "running" })
      try {
        const result = await importLocalConversations(folderId)
        updateTask(taskId, { status: "completed" })
        refreshConversations()
        if (result.imported > 0) {
          toast.success(
            t("toasts.importedSessions", {
              imported: result.imported,
              skipped: result.skipped,
            })
          )
        } else {
          toast.info(
            t("toasts.noNewSessionsFound", { skipped: result.skipped })
          )
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateTask(taskId, { status: "failed", error: msg })
        toast.error(t("toasts.importFailed", { message: msg }))
      } finally {
        setImporting(false)
      }
    },
    [importing, addTask, updateTask, refreshConversations, t]
  )

  const handleOpenFolderAction = useCallback(async () => {
    if (isDesktop()) {
      try {
        const result = await openFileDialog({
          directory: true,
          multiple: false,
        })
        if (!result) return
        const selected = Array.isArray(result) ? result[0] : result
        await openFolder(selected)
      } catch (err) {
        console.error("[SidebarConversationList] failed to open folder:", err)
      }
    } else {
      setBrowserOpen(true)
    }
  }, [openFolder])

  const handleBrowserSelect = useCallback(
    (path: string) => {
      openFolder(path).catch((err) => {
        console.error("[SidebarConversationList] failed to open folder:", err)
      })
    },
    [openFolder]
  )

  const handleProjectBoot = useCallback(() => {
    openProjectBootWindow().catch((err) => {
      console.error(
        "[SidebarConversationList] failed to open project boot:",
        err
      )
    })
  }, [])

  const showEmptyWorkspaceActions =
    folders.length === 0 && conversations.length === 0

  return (
    <div className="relative flex flex-col flex-1 min-h-0">
      {(loading || refreshing) && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-center py-1 z-10 pointer-events-none">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      )}

      {loading && !refreshing ? (
        <div className="px-3 space-y-1.5 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-md" />
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center px-3">
          <p className="text-destructive text-xs">
            {t("error", { message: error })}
          </p>
        </div>
      ) : showEmptyWorkspaceActions ? (
        <div className="flex-1 flex flex-col items-center justify-center px-3 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full max-w-[14rem] justify-start"
            onClick={handleOpenFolderAction}
          >
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
            {tFolderDropdown("openFolder")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full max-w-[14rem] justify-start"
            onClick={() => setCloneOpen(true)}
          >
            <GitBranch className="h-3.5 w-3.5 mr-1.5" />
            {tFolderDropdown("cloneRepository")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full max-w-[14rem] justify-start"
            onClick={handleProjectBoot}
          >
            <Rocket className="h-3.5 w-3.5 mr-1.5" />
            {tFolderDropdown("projectBoot")}
          </Button>
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex-1 min-h-0 relative">
              {stickyFolderItem && (
                <div
                  className="absolute top-0 left-0 right-0 z-10"
                  style={{
                    transform: `translateY(${stickyState.pushOffset}px)`,
                  }}
                >
                  <div
                    aria-hidden
                    className="absolute inset-0 right-[0.5rem] bg-sidebar"
                  />
                  <div className="relative px-2">
                    <FolderHeader
                      key={`sticky-${stickyFolderItem.folderId}`}
                      folderId={stickyFolderItem.folderId}
                      folderName={stickyFolderItem.folderName}
                      count={stickyFolderItem.count}
                      expanded={stickyFolderItem.expanded}
                      importing={importing}
                      onToggle={toggleFolder}
                      onRemoveFromWorkspace={handleRemoveFolder}
                      onNewConversation={handleNewConversationForFolder}
                      onImport={handleImportForFolder}
                      onManageConversations={handleManageConversations}
                      t={t}
                    />
                  </div>
                </div>
              )}
              <ScrollArea
                className={cn(
                  "h-full min-h-0 px-2 pb-[1.25rem]",
                  "[overflow-anchor:none]"
                )}
              >
                <Virtualizer
                  ref={virtualizerRef}
                  itemSize={cardHeightPx}
                  onScroll={setScrollOffset}
                >
                  {flatItems.map((item) => {
                    if (item.type === "folder_header") {
                      return (
                        <FolderHeader
                          key={`folder-${item.folderId}`}
                          folderId={item.folderId}
                          folderName={item.folderName}
                          count={item.count}
                          expanded={item.expanded}
                          importing={importing}
                          onToggle={toggleFolder}
                          onRemoveFromWorkspace={handleRemoveFolder}
                          onNewConversation={handleNewConversationForFolder}
                          onImport={handleImportForFolder}
                          onManageConversations={handleManageConversations}
                          t={t}
                        />
                      )
                    }
                    const conv = item.conversation
                    return (
                      <SidebarConversationCard
                        key={`conv-${conv.id}`}
                        conversation={conv}
                        isSelected={
                          selectedConversation?.agentType === conv.agent_type &&
                          selectedConversation?.id === conv.id
                        }
                        timeLabel={formatRelative(conv.updated_at)}
                        onSelect={handleSelect}
                        onDoubleClick={handleDoubleClick}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onStatusChange={handleStatusChange}
                        onNewConversation={handleNewConversation}
                      />
                    )
                  })}
                </Virtualizer>
              </ScrollArea>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={handleNewConversation}
              disabled={!activeFolder}
            >
              <Plus className="h-4 w-4" />
              {t("newConversation")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      <AlertDialog
        open={removeConfirm !== null}
        onOpenChange={(open) => !open && setRemoveConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeFolderConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeFolderConfirmDescription", {
                name: removeConfirm?.folderName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveFolderConfirm}>
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {manageState && (
        <ConversationManageDialog
          open
          onOpenChange={(o) => !o && setManageState(null)}
          folderId={manageState.folderId}
          folderName={manageState.folderName}
        />
      )}

      <CloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      <DirectoryBrowserDialog
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={handleBrowserSelect}
      />
    </div>
  )
}
