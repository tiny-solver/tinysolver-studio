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
  CheckCheck,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  XCircle,
} from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useTaskContext } from "@/contexts/task-context"
import {
  importLocalConversations,
  updateConversationTitle,
  updateConversationStatus,
  deleteConversation,
} from "@/lib/api"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import { STATUS_ORDER, STATUS_COLORS } from "@/lib/types"
import {
  loadFolderExpanded,
  saveFolderExpanded,
  type SidebarViewMode,
} from "@/lib/sidebar-view-mode-storage"
import { SidebarConversationCard } from "./sidebar-conversation-card"
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

type FlatItem =
  | {
      type: "folder_header"
      folderId: number
      folderName: string
      branch: string | null
      count: number
      expanded: boolean
    }
  | {
      type: "status_header"
      status: ConversationStatus
      count: number
      parentFolderId?: number
    }
  | { type: "conversation"; conversation: DbConversationSummary }

const CARD_HEIGHT = 62

const FolderHeader = memo(function FolderHeader({
  folderId,
  folderName,
  branch,
  count,
  expanded,
  onToggle,
  onFocus,
  onCloseFolderTabs,
  onRemoveFromWorkspace,
  highlighted,
  t,
}: {
  folderId: number
  folderName: string
  branch: string | null
  count: number
  expanded: boolean
  onToggle: (folderId: number) => void
  onFocus: (folderId: number) => void
  onCloseFolderTabs: (folderId: number) => void
  onRemoveFromWorkspace: (folderId: number) => void
  highlighted: boolean
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          data-folder-id={folderId}
          onClick={() => onToggle(folderId)}
          className={cn(
            "flex items-center gap-1.5 w-full px-1.5 py-1.5 text-xs font-medium cursor-pointer transition-all",
            "text-foreground hover:bg-accent/50 rounded-sm",
            highlighted && "ring-2 ring-primary ring-offset-1"
          )}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform text-muted-foreground",
              expanded && "rotate-90"
            )}
          />
          <span className="truncate flex-1 text-left">{folderName}</span>
          {branch && (
            <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
              {branch}
            </span>
          )}
          <span className="text-muted-foreground/60 tabular-nums text-[10px]">
            ({count})
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onFocus(folderId)}>
          {t("folderHeaderMenu.focus")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCloseFolderTabs(folderId)}>
          {t("folderHeaderMenu.closeFolderTabs")}
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

const StatusHeader = memo(function StatusHeader({
  status,
  count,
  isOpen,
  onToggle,
  tStatus,
}: {
  status: ConversationStatus
  count: number
  isOpen: boolean
  onToggle: (status: ConversationStatus) => void
  tStatus: ReturnType<typeof useTranslations>
}) {
  return (
    <button
      onClick={() => onToggle(status)}
      className="flex items-center gap-1.5 w-full px-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      <ChevronRight
        className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isOpen && "rotate-90"
        )}
      />
      <span
        className={cn("w-2 h-2 rounded-full shrink-0", STATUS_COLORS[status])}
      />
      <span>{tStatus(status)}</span>
      <span className="text-muted-foreground/60 tabular-nums">({count})</span>
    </button>
  )
})

const PendingReviewHeader = memo(function PendingReviewHeader({
  count,
  isOpen,
  onToggle,
  reviewConversationCount,
  completingReview,
  onCompleteReview,
  tStatus,
  t,
}: {
  count: number
  isOpen: boolean
  onToggle: (status: ConversationStatus) => void
  reviewConversationCount: number
  completingReview: boolean
  onCompleteReview: () => void
  tStatus: ReturnType<typeof useTranslations>
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => onToggle("pending_review")}
          className="flex items-center gap-1.5 w-full px-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              isOpen && "rotate-90"
            )}
          />
          <span
            className={cn(
              "w-2 h-2 rounded-full shrink-0",
              STATUS_COLORS.pending_review
            )}
          />
          <span>{tStatus("pending_review")}</span>
          <span className="text-muted-foreground/60 tabular-nums">
            ({count})
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={reviewConversationCount === 0 || completingReview}
          onSelect={onCompleteReview}
        >
          <CheckCheck className="h-4 w-4" />
          {t("completeAllSessions")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

export interface SidebarConversationListHandle {
  scrollToActive: () => void
  expandAll: () => void
  collapseAll: () => void
  revealFolder: (folderId: number) => void
}

export interface SidebarConversationListProps {
  viewMode?: SidebarViewMode
  searchQuery?: string
}

export function SidebarConversationList({
  ref,
  viewMode = "flat",
  searchQuery = "",
}: SidebarConversationListProps & {
  ref?: Ref<SidebarConversationListHandle>
}) {
  const t = useTranslations("Folder.sidebar")
  const tStatus = useTranslations("Folder.statusLabels")
  const tCommon = useTranslations("Folder.common")
  const {
    allFolders,
    conversations,
    conversationsLoading: loading,
    conversationsError: error,
    refreshConversations,
    updateConversationLocal,
    branches,
    removeFolderFromWorkspace,
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
  const [completeReviewOpen, setCompleteReviewOpen] = useState(false)
  const [completingReview, setCompletingReview] = useState(false)
  const [groupExpanded, setGroupExpanded] = useState<
    Record<ConversationStatus, boolean>
  >({
    in_progress: true,
    pending_review: true,
    completed: false,
    cancelled: false,
  })
  const [folderExpanded, setFolderExpanded] = useState<Record<number, boolean>>(
    {}
  )
  const [highlightedFolder, setHighlightedFolder] = useState<number | null>(
    null
  )
  const [removeConfirm, setRemoveConfirm] = useState<{
    folderId: number
    folderName: string
  } | null>(null)

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.

    setFolderExpanded(loadFolderExpanded())
  }, [])

  const scrollToActiveRef = useRef<() => void>(() => {})
  const pendingScrollRef = useRef(false)
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const highlightTimerRef = useRef<number | null>(null)

  const normalizedSearch = searchQuery.trim().toLowerCase()
  const filteredConversations = useMemo(() => {
    if (!normalizedSearch) return conversations
    return conversations.filter((c) => {
      const title = (c.title ?? "").toLowerCase()
      return title.includes(normalizedSearch)
    })
  }, [conversations, normalizedSearch])

  const byStatus = useMemo(() => {
    const map = new Map<ConversationStatus, DbConversationSummary[]>()
    for (const conv of filteredConversations) {
      const status = conv.status as ConversationStatus
      const list = map.get(status)
      if (list) list.push(conv)
      else map.set(status, [conv])
    }
    for (const list of map.values()) list.sort(compareByUpdatedAtDesc)
    return map
  }, [filteredConversations])

  const byFolder = useMemo(() => {
    const map = new Map<
      number,
      Map<ConversationStatus, DbConversationSummary[]>
    >()
    for (const conv of filteredConversations) {
      const folderId = conv.folder_id
      let inner = map.get(folderId)
      if (!inner) {
        inner = new Map<ConversationStatus, DbConversationSummary[]>()
        map.set(folderId, inner)
      }
      const status = conv.status as ConversationStatus
      const list = inner.get(status)
      if (list) list.push(conv)
      else inner.set(status, [conv])
    }
    for (const inner of map.values()) {
      for (const list of inner.values()) list.sort(compareByUpdatedAtDesc)
    }
    return map
  }, [filteredConversations])

  const orderedFolderIds = useMemo(() => {
    // Show every folder in the workspace DB, even ones without conversations.
    // Folders that only have orphan conversations still appear via byFolder.
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
    if (viewMode === "grouped") {
      for (const folderId of orderedFolderIds) {
        const inner = byFolder.get(folderId)
        const totalCount = inner
          ? Array.from(inner.values()).reduce(
              (sum, list) => sum + list.length,
              0
            )
          : 0
        const folderName = folderIndex.get(folderId)?.name ?? String(folderId)
        const branch = branches.get(folderId) ?? null
        const expanded = folderExpanded[folderId] ?? true
        items.push({
          type: "folder_header",
          folderId,
          folderName,
          branch,
          count: totalCount,
          expanded,
        })
        if (!expanded || !inner) continue
        for (const status of STATUS_ORDER) {
          const list = inner.get(status)
          if (!list || list.length === 0) continue
          items.push({
            type: "status_header",
            status,
            count: list.length,
            parentFolderId: folderId,
          })
          if (groupExpanded[status]) {
            for (const conv of list) {
              items.push({ type: "conversation", conversation: conv })
            }
          }
        }
      }
    } else {
      for (const status of STATUS_ORDER) {
        const list = byStatus.get(status)
        if (!list || list.length === 0) continue
        items.push({ type: "status_header", status, count: list.length })
        if (groupExpanded[status]) {
          for (const conv of list) {
            items.push({ type: "conversation", conversation: conv })
          }
        }
      }
    }
    return items
  }, [
    viewMode,
    orderedFolderIds,
    byFolder,
    folderIndex,
    branches,
    folderExpanded,
    byStatus,
    groupExpanded,
  ])

  const reviewConversations = useMemo(
    () => byStatus.get("pending_review") ?? [],
    [byStatus]
  )
  const reviewConversationCount = reviewConversations.length

  useImperativeHandle(ref, () => ({
    scrollToActive() {
      scrollToActiveRef.current()
    },
    expandAll() {
      setGroupExpanded({
        in_progress: true,
        pending_review: true,
        completed: true,
        cancelled: true,
      })
    },
    collapseAll() {
      setGroupExpanded({
        in_progress: false,
        pending_review: false,
        completed: false,
        cancelled: false,
      })
    },
    revealFolder(folderId: number) {
      setFolderExpanded((prev) => {
        if (prev[folderId] === true) return prev
        const next = { ...prev, [folderId]: true }
        saveFolderExpanded(next)
        return next
      })
      setHighlightedFolder(folderId)
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current)
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightedFolder(null)
        highlightTimerRef.current = null
      }, 1200)
      requestAnimationFrame(() => {
        const idx = flatItems.findIndex(
          (item) => item.type === "folder_header" && item.folderId === folderId
        )
        if (idx >= 0) {
          virtualizerRef.current?.scrollToIndex(idx, {
            align: "start",
            smooth: true,
          })
        }
      })
    },
  }))

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    scrollToActiveRef.current = () => {
      if (!selectedConversation) return
      const targetId = selectedConversation.id
      const targetAgent = selectedConversation.agentType
      const conv = conversations.find(
        (c) => c.id === targetId && c.agent_type === targetAgent
      )
      if (!conv) return
      const status = conv.status as ConversationStatus
      if (!groupExpanded[status]) {
        setGroupExpanded((prev) => ({ ...prev, [status]: true }))
        pendingScrollRef.current = true
        return
      }
      if (viewMode === "grouped" && !(folderExpanded[conv.folder_id] ?? true)) {
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
  }, [
    selectedConversation,
    flatItems,
    conversations,
    groupExpanded,
    folderExpanded,
    viewMode,
  ])

  const toggleGroup = useCallback((status: ConversationStatus) => {
    setGroupExpanded((prev) => ({ ...prev, [status]: !prev[status] }))
  }, [])

  const toggleFolder = useCallback((folderId: number) => {
    setFolderExpanded((prev) => {
      const next = { ...prev, [folderId]: !(prev[folderId] ?? true) }
      saveFolderExpanded(next)
      return next
    })
  }, [])

  const focusFolder = useCallback(
    (folderId: number) => {
      const idx = flatItems.findIndex(
        (item) => item.type === "folder_header" && item.folderId === folderId
      )
      if (idx >= 0) {
        virtualizerRef.current?.scrollToIndex(idx, {
          align: "start",
          smooth: true,
        })
      }
    },
    [flatItems]
  )

  const handleCloseFolderTabs = useCallback(
    (folderId: number) => {
      closeTabsByFolder(folderId)
    },
    [closeTabsByFolder]
  )

  const handleRemoveFolder = useCallback(
    (folderId: number) => {
      const name = folderIndex.get(folderId)?.name ?? String(folderId)
      setRemoveConfirm({ folderId, folderName: name })
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

  const handleOpenCompleteReview = useCallback(
    () => setCompleteReviewOpen(true),
    []
  )

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

  const handleImport = useCallback(async () => {
    if (importing) return
    if (!activeFolder) return
    setImporting(true)
    const taskId = `import-${activeFolder.id}-${Date.now()}`
    addTask(taskId, t("importLocalSessions"))
    updateTask(taskId, { status: "running" })
    try {
      const result = await importLocalConversations(activeFolder.id)
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
        toast.info(t("toasts.noNewSessionsFound", { skipped: result.skipped }))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      updateTask(taskId, { status: "failed", error: msg })
      toast.error(t("toasts.importFailed", { message: msg }))
    } finally {
      setImporting(false)
    }
  }, [importing, activeFolder, addTask, updateTask, refreshConversations, t])

  const handleCompleteAllReview = useCallback(async () => {
    if (completingReview || reviewConversationCount === 0) return
    setCompletingReview(true)
    try {
      for (const conversation of reviewConversations) {
        updateConversationLocal(conversation.id, { status: "completed" })
      }
      await Promise.all(
        reviewConversations.map((conversation) =>
          updateConversationStatus(conversation.id, "completed")
        )
      )
      toast.success(
        t("toasts.reviewCompleted", { count: reviewConversationCount })
      )
      setCompleteReviewOpen(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(t("toasts.completeReviewFailed", { message: msg }))
      refreshConversations()
    } finally {
      setCompletingReview(false)
    }
  }, [
    completingReview,
    reviewConversationCount,
    reviewConversations,
    refreshConversations,
    updateConversationLocal,
    t,
  ])

  const emptyAfterSearch =
    filteredConversations.length === 0 && normalizedSearch.length > 0

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
      ) : conversations.length === 0 ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex-1 flex flex-col items-center justify-center px-3 gap-3">
              <p className="text-muted-foreground text-xs text-center">
                {t("noConversationsFound")}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={importing || !activeFolder}
                onClick={handleImport}
              >
                {importing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                )}
                {importing ? t("importing") : t("importLocalSessions")}
              </Button>
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
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={importing || !activeFolder}
              onSelect={handleImport}
            >
              <Download className="h-4 w-4" />
              {importing ? t("importing") : t("importLocalSessions")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : emptyAfterSearch ? (
        <div className="flex-1 flex items-center justify-center px-3">
          <p className="text-muted-foreground text-xs text-center">
            {t("noMatchingConversations")}
          </p>
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex-1 min-h-0">
              <ScrollArea
                className={cn("h-full min-h-0 px-2", "[overflow-anchor:none]")}
              >
                <Virtualizer ref={virtualizerRef} itemSize={CARD_HEIGHT}>
                  {flatItems.map((item, index) => {
                    if (item.type === "folder_header") {
                      return (
                        <FolderHeader
                          key={`folder-${item.folderId}`}
                          folderId={item.folderId}
                          folderName={item.folderName}
                          branch={item.branch}
                          count={item.count}
                          expanded={item.expanded}
                          onToggle={toggleFolder}
                          onFocus={focusFolder}
                          onCloseFolderTabs={handleCloseFolderTabs}
                          onRemoveFromWorkspace={handleRemoveFolder}
                          highlighted={highlightedFolder === item.folderId}
                          t={t}
                        />
                      )
                    }
                    const indented =
                      viewMode === "grouped" &&
                      (item.type === "status_header"
                        ? item.parentFolderId != null
                        : true)
                    if (item.type === "status_header") {
                      const key = `status-${item.parentFolderId ?? "root"}-${item.status}-${index}`
                      const headerNode =
                        item.status === "pending_review" ? (
                          <PendingReviewHeader
                            key={key}
                            count={item.count}
                            isOpen={groupExpanded[item.status]}
                            onToggle={toggleGroup}
                            reviewConversationCount={reviewConversationCount}
                            completingReview={completingReview}
                            onCompleteReview={handleOpenCompleteReview}
                            tStatus={tStatus}
                            t={t}
                          />
                        ) : (
                          <StatusHeader
                            key={key}
                            status={item.status}
                            count={item.count}
                            isOpen={groupExpanded[item.status]}
                            onToggle={toggleGroup}
                            tStatus={tStatus}
                          />
                        )
                      return indented ? (
                        <div key={key} className="pl-4">
                          {headerNode}
                        </div>
                      ) : (
                        headerNode
                      )
                    }
                    const conv = item.conversation
                    const cardNode = (
                      <SidebarConversationCard
                        conversation={conv}
                        isSelected={
                          selectedConversation?.agentType === conv.agent_type &&
                          selectedConversation?.id === conv.id
                        }
                        onSelect={handleSelect}
                        onDoubleClick={handleDoubleClick}
                        onRename={handleRename}
                        onDelete={handleDelete}
                        onStatusChange={handleStatusChange}
                        onNewConversation={handleNewConversation}
                        onImport={handleImport}
                        importing={importing}
                      />
                    )
                    return indented ? (
                      <div key={`conv-${conv.id}`} className="pl-4">
                        {cardNode}
                      </div>
                    ) : (
                      <div key={`conv-${conv.id}`}>{cardNode}</div>
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
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={importing || !activeFolder}
              onSelect={handleImport}
            >
              <Download className="h-4 w-4" />
              {importing ? t("importing") : t("importLocalSessions")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <AlertDialog
        open={completeReviewOpen}
        onOpenChange={(open) =>
          !completingReview && setCompleteReviewOpen(open)
        }
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("completeAllReviewTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("completeAllReviewDescription", {
                count: reviewConversationCount,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={completingReview}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={completingReview || reviewConversationCount === 0}
              onClick={handleCompleteAllReview}
            >
              {completingReview ? t("completing") : tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  )
}
