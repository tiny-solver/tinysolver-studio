"use client"

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Check,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitMerge,
  Loader2,
  MoreHorizontal,
  Upload,
  Plus,
  Archive,
  Trash2,
} from "lucide-react"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useTaskContext } from "@/contexts/task-context"
import {
  gitListAllBranches,
  gitCheckout,
  gitNewBranch,
  gitDeleteBranch,
  openCommitWindow,
  openPushWindow,
  openStashWindow,
  openMergeWindow,
} from "@/lib/api"
import { isDesktop, openFileDialog } from "@/lib/platform"
import type { GitBranchList } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export const ConversationContextBar = memo(function ConversationContextBar() {
  const t = useTranslations("Folder.conversationContextBar")
  const tBd = useTranslations("Folder.branchDropdown")
  const { tabs, activeTabId, setTabFolder } = useTabContext()
  const {
    folders,
    allFolders,
    branches,
    setBranch,
    openFolder,
    addFolderToWorkspaceById,
    refreshFolder,
  } = useAppWorkspace()
  const { addTask, updateTask } = useTaskContext()

  const activeTab = useMemo(
    () => tabs.find((x) => x.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  const activeFolder = useMemo(
    () =>
      activeTab
        ? (allFolders.find((f) => f.id === activeTab.folderId) ?? null)
        : null,
    [activeTab, allFolders]
  )

  if (!activeTab || !activeFolder) return null

  const isNewConversation = activeTab.conversationId == null
  const currentBranch =
    branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1.5 h-9 px-3 border-b border-border/40 bg-muted/20 text-xs">
        <FolderPicker
          folders={allFolders}
          currentFolderId={activeFolder.id}
          currentFolderName={activeFolder.name}
          editable={isNewConversation}
          onSelect={async (folderId) => {
            const target = allFolders.find((f) => f.id === folderId)
            if (!target) return
            const isOpen = folders.some((f) => f.id === folderId)
            try {
              const detail = isOpen
                ? target
                : await addFolderToWorkspaceById(folderId)
              setTabFolder(activeTab.id, detail.id, detail.path)
              toast.success(t("toasts.folderChanged", { name: detail.name }))
            } catch (err) {
              console.error(
                "[ConversationContextBar] switch folder failed:",
                err
              )
              toast.error(t("toasts.openFolderFailed"))
            }
          }}
          onOpenNewFolder={async () => {
            try {
              if (isDesktop()) {
                const result = await openFileDialog({
                  directory: true,
                  multiple: false,
                })
                if (!result) return
                const selected = Array.isArray(result) ? result[0] : result
                const detail = await openFolder(selected)
                setTabFolder(activeTab.id, detail.id, detail.path)
                toast.success(t("toasts.folderChanged", { name: detail.name }))
              }
            } catch (err) {
              console.error("[ConversationContextBar] open folder failed:", err)
              toast.error(t("toasts.openFolderFailed"))
            }
          }}
          labelOpenNew={t("openNewFolder")}
          labelEmpty={t("noFolders")}
          labelSearch={t("searchFolder")}
        />

        <Separator orientation="vertical" className="h-4" />

        <BranchPicker
          folderId={activeFolder.id}
          folderPath={activeFolder.path}
          currentBranch={currentBranch}
          onCheckout={async (branchName) => {
            const taskId = `checkout-${activeFolder.id}-${Date.now()}`
            addTask(taskId, tBd("tasks.checkoutTo", { branchName }))
            updateTask(taskId, { status: "running" })
            try {
              await gitCheckout(activeFolder.path, branchName)
              setBranch(activeFolder.id, branchName)
              await refreshFolder(activeFolder.id)
              updateTask(taskId, { status: "completed" })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              updateTask(taskId, { status: "failed", error: msg })
              toast.error(msg)
            }
          }}
          onNewBranch={async (branchName, startPoint) => {
            const taskId = `new-branch-${activeFolder.id}-${Date.now()}`
            addTask(taskId, tBd("tasks.newBranch", { name: branchName }))
            updateTask(taskId, { status: "running" })
            try {
              await gitNewBranch(activeFolder.path, branchName, startPoint)
              setBranch(activeFolder.id, branchName)
              await refreshFolder(activeFolder.id)
              updateTask(taskId, { status: "completed" })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              updateTask(taskId, { status: "failed", error: msg })
              toast.error(msg)
            }
          }}
          onDeleteBranch={async (branchName) => {
            const taskId = `delete-branch-${activeFolder.id}-${Date.now()}`
            addTask(taskId, tBd("tasks.deleteBranch", { branchName }))
            updateTask(taskId, { status: "running" })
            try {
              await gitDeleteBranch(activeFolder.path, branchName, false)
              updateTask(taskId, { status: "completed" })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              updateTask(taskId, { status: "failed", error: msg })
              toast.error(msg)
            }
          }}
        />

        <div className="flex-1" />

        <GitActionButtons
          folderId={activeFolder.id}
          currentBranch={currentBranch}
        />
      </div>
    </TooltipProvider>
  )
})

ConversationContextBar.displayName = "ConversationContextBar"

// ============================================================================
// FolderPicker
// ============================================================================

interface FolderPickerProps {
  folders: { id: number; name: string; path: string }[]
  currentFolderId: number
  currentFolderName: string
  editable: boolean
  onSelect: (folderId: number) => void | Promise<void>
  onOpenNewFolder: () => void | Promise<void>
  labelOpenNew: string
  labelEmpty: string
  labelSearch: string
}

const FolderPicker = memo(function FolderPicker({
  folders,
  currentFolderId,
  currentFolderName,
  editable,
  onSelect,
  onOpenNewFolder,
  labelOpenNew,
  labelEmpty,
  labelSearch,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false)

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-7 px-2 gap-1.5 font-normal",
        !editable && "cursor-default hover:bg-transparent"
      )}
      disabled={!editable && false}
    >
      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="max-w-[140px] truncate">{currentFolderName}</span>
      {editable && (
        <ChevronsUpDown className="h-3 w-3 text-muted-foreground opacity-60" />
      )}
    </Button>
  )

  if (!editable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="bottom">{currentFolderName}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-72">
        <Command>
          <CommandInput placeholder={labelSearch} />
          <CommandList>
            <CommandEmpty>{labelEmpty}</CommandEmpty>
            <CommandGroup>
              {folders.map((f) => (
                <CommandItem
                  key={f.id}
                  value={`${f.name} ${f.path}`}
                  onSelect={() => {
                    setOpen(false)
                    void onSelect(f.id)
                  }}
                >
                  <Folder className="h-4 w-4" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {f.path}
                    </span>
                  </div>
                  {f.id === currentFolderId && (
                    <Check className="h-4 w-4 shrink-0" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  void onOpenNewFolder()
                }}
              >
                <FolderOpen className="h-4 w-4" />
                {labelOpenNew}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
})

// ============================================================================
// BranchPicker
// ============================================================================

interface BranchPickerProps {
  folderId: number
  folderPath: string
  currentBranch: string | null
  onCheckout: (branchName: string) => Promise<void>
  onNewBranch: (branchName: string, startPoint?: string) => Promise<void>
  onDeleteBranch: (branchName: string) => Promise<void>
}

const BranchPicker = memo(function BranchPicker({
  folderId,
  folderPath,
  currentBranch,
  onCheckout,
  onNewBranch,
  onDeleteBranch,
}: BranchPickerProps) {
  const t = useTranslations("Folder.conversationContextBar")
  const tBd = useTranslations("Folder.branchDropdown")
  const [open, setOpen] = useState(false)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [loading, setLoading] = useState(false)
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")

  const loadBranches = useCallback(async () => {
    setLoading(true)
    try {
      const list = await gitListAllBranches(folderPath)
      setBranchList(list)
    } catch (err) {
      console.error("[BranchPicker] list failed:", err)
      setBranchList({ local: [], remote: [], worktree_branches: [] })
    } finally {
      setLoading(false)
    }
  }, [folderPath])

  useEffect(() => {
    if (open) void loadBranches()
  }, [open, loadBranches])

  // Reset branches cache when folder changes
  useEffect(() => {
    setBranchList(null)
  }, [folderId])

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 font-normal"
          >
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="max-w-[160px] truncate">
              {currentBranch ?? t("noBranch")}
            </span>
            <ChevronsUpDown className="h-3 w-3 text-muted-foreground opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0 w-80">
          <Command>
            <CommandInput placeholder={t("searchBranch")} />
            <CommandList>
              {loading ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin mx-auto" />
                </div>
              ) : (
                <>
                  <CommandEmpty>{t("noBranches")}</CommandEmpty>
                  {branchList && branchList.local.length > 0 && (
                    <CommandGroup
                      heading={tBd("localBranches", {
                        count: branchList.local.length,
                      })}
                    >
                      {branchList.local.map((b) => (
                        <CommandItem
                          key={`local-${b}`}
                          value={`local ${b}`}
                          onSelect={() => {
                            setOpen(false)
                            if (b !== currentBranch) void onCheckout(b)
                          }}
                        >
                          <GitBranch className="h-4 w-4" />
                          <span className="flex-1 truncate">{b}</span>
                          {b === currentBranch && (
                            <Check className="h-4 w-4 shrink-0" />
                          )}
                          {b !== currentBranch && (
                            <Trash2
                              className="h-3.5 w-3.5 opacity-50 hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpen(false)
                                void onDeleteBranch(b)
                              }}
                            />
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {branchList && branchList.remote.length > 0 && (
                    <CommandGroup
                      heading={tBd("remoteBranches", {
                        count: branchList.remote.length,
                      })}
                    >
                      {branchList.remote.map((b) => (
                        <CommandItem
                          key={`remote-${b}`}
                          value={`remote ${b}`}
                          onSelect={() => {
                            setOpen(false)
                            void onCheckout(b)
                          }}
                        >
                          <GitBranch className="h-4 w-4 opacity-60" />
                          <span className="flex-1 truncate text-muted-foreground">
                            {b}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setOpen(false)
                        setNewBranchName("")
                        setNewBranchOpen(true)
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      {tBd("newBranch")}
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog open={newBranchOpen} onOpenChange={setNewBranchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tBd("dialogs.newBranchTitle")}</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            {tBd("dialogs.newBranchDescription", {
              branch: currentBranch ?? "-",
            })}
          </div>
          <Input
            placeholder={tBd("dialogs.branchNamePlaceholder")}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewBranchOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!newBranchName.trim()}
              onClick={async () => {
                const name = newBranchName.trim()
                if (!name) return
                setNewBranchOpen(false)
                await onNewBranch(name, currentBranch ?? undefined)
              }}
            >
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})

// ============================================================================
// GitActionButtons
// ============================================================================

interface GitActionButtonsProps {
  folderId: number
  currentBranch: string | null
}

const GitActionButtons = memo(function GitActionButtons({
  folderId,
  currentBranch,
}: GitActionButtonsProps) {
  const t = useTranslations("Folder.conversationContextBar")
  const tBd = useTranslations("Folder.branchDropdown")

  const handleCommit = useCallback(async () => {
    try {
      await openCommitWindow(folderId)
    } catch (err) {
      console.error("[GitActions] commit failed:", err)
      toast.error(tBd("toasts.openCommitWindowFailed"))
    }
  }, [folderId, tBd])

  const handlePush = useCallback(async () => {
    try {
      await openPushWindow(folderId)
    } catch (err) {
      console.error("[GitActions] push failed:", err)
      toast.error(tBd("toasts.openPushWindowFailed"))
    }
  }, [folderId, tBd])

  const handleStash = useCallback(async () => {
    try {
      await openStashWindow(folderId)
    } catch (err) {
      console.error("[GitActions] stash failed:", err)
      toast.error(t("toasts.openStashFailed"))
    }
  }, [folderId, t])

  const handleMerge = useCallback(async () => {
    try {
      await openMergeWindow(folderId, "merge")
    } catch (err) {
      console.error("[GitActions] merge failed:", err)
      toast.error(t("toasts.openMergeFailed"))
    }
  }, [folderId, t])

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 font-normal"
            onClick={handleCommit}
            disabled={currentBranch == null}
          >
            <GitCommit className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("commit")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tBd("openCommitWindow")}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1.5 font-normal"
            onClick={handlePush}
            disabled={currentBranch == null}
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t("push")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tBd("pushCode")}</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={currentBranch == null}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleMerge}>
            <GitMerge className="h-4 w-4" />
            {t("merge")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleStash}>
            <Archive className="h-4 w-4" />
            {tBd("stashChanges")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCommit}>
            <GitCommit className="h-4 w-4" />
            {tBd("openCommitWindow")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handlePush}>
            <Upload className="h-4 w-4" />
            {tBd("pushCode")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
