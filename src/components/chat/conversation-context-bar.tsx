"use client"

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Check, ChevronsUpDown, Folder, GitBranch, Loader2 } from "lucide-react"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import { useTabContext } from "@/contexts/tab-context"
import { useTaskContext } from "@/contexts/task-context"
import { gitListAllBranches, gitCheckout } from "@/lib/api"
import type { GitBranchList } from "@/lib/types"
import { Button } from "@/components/ui/button"
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
} from "@/components/ui/command"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface ConversationContextBarProps {
  tabId?: string | null
}

export const ConversationContextBar = memo(function ConversationContextBar({
  tabId,
}: ConversationContextBarProps = {}) {
  const t = useTranslations("Folder.conversationContextBar")
  const tBd = useTranslations("Folder.branchDropdown")
  const { tabs, activeTabId, setTabFolder } = useTabContext()
  const {
    folders,
    allFolders,
    branches,
    setBranch,
    addFolderToWorkspaceById,
    refreshFolder,
  } = useAppWorkspace()
  const { addTask, updateTask } = useTaskContext()

  const ownTab = useMemo(() => {
    const lookupId = tabId ?? activeTabId
    return tabs.find((x) => x.id === lookupId) ?? null
  }, [tabs, tabId, activeTabId])

  const ownFolder = useMemo(
    () =>
      ownTab
        ? (allFolders.find((f) => f.id === ownTab.folderId) ?? null)
        : null,
    [ownTab, allFolders]
  )

  if (!ownTab || !ownFolder) return null

  const isNewConversation = ownTab.conversationId == null
  const currentBranch =
    branches.get(ownFolder.id) ?? ownFolder.git_branch ?? null

  return (
    <TooltipProvider>
      <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
        <FolderPicker
          folders={allFolders}
          currentFolderId={ownFolder.id}
          currentFolderName={ownFolder.name}
          editable={isNewConversation}
          onSelect={async (folderId) => {
            const target = allFolders.find((f) => f.id === folderId)
            if (!target) return
            const isOpen = folders.some((f) => f.id === folderId)
            try {
              const detail = isOpen
                ? target
                : await addFolderToWorkspaceById(folderId)
              setTabFolder(ownTab.id, detail.id, detail.path)
              toast.success(t("toasts.folderChanged", { name: detail.name }))
            } catch (err) {
              console.error(
                "[ConversationContextBar] switch folder failed:",
                err
              )
              toast.error(t("toasts.openFolderFailed"))
            }
          }}
          labelEmpty={t("noFolders")}
          labelSearch={t("searchFolder")}
        />

        <BranchPicker
          folderId={ownFolder.id}
          folderPath={ownFolder.path}
          currentBranch={currentBranch}
          onCheckout={async (branchName) => {
            const taskId = `checkout-${ownFolder.id}-${Date.now()}`
            addTask(taskId, tBd("tasks.checkoutTo", { branchName }))
            updateTask(taskId, { status: "running" })
            try {
              await gitCheckout(ownFolder.path, branchName)
              setBranch(ownFolder.id, branchName)
              await refreshFolder(ownFolder.id)
              updateTask(taskId, { status: "completed" })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              updateTask(taskId, { status: "failed", error: msg })
              toast.error(msg)
            }
          }}
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
  labelEmpty: string
  labelSearch: string
}

const FolderPicker = memo(function FolderPicker({
  folders,
  currentFolderId,
  currentFolderName,
  editable,
  onSelect,
  labelEmpty,
  labelSearch,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false)

  const trigger = (
    <Button
      variant="outline"
      size="xs"
      className={cn(
        "min-w-0 bg-transparent",
        !editable && "cursor-default opacity-60 hover:bg-transparent"
      )}
    >
      <Folder className="size-3 shrink-0 text-muted-foreground" />
      <span className="max-w-[140px] truncate">{currentFolderName}</span>
      <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
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
      <PopoverContent align="start" className="p-0 w-72 overflow-hidden">
        <Command className="rounded-2xl">
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
}

const BranchPicker = memo(function BranchPicker({
  folderId,
  folderPath,
  currentBranch,
  onCheckout,
}: BranchPickerProps) {
  const t = useTranslations("Folder.conversationContextBar")
  const tBd = useTranslations("Folder.branchDropdown")
  const [open, setOpen] = useState(false)
  const [branchList, setBranchList] = useState<GitBranchList | null>(null)
  const [loading, setLoading] = useState(false)

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="min-w-0 bg-transparent">
          <GitBranch className="size-3 shrink-0 text-muted-foreground" />
          <span className="max-w-[160px] truncate">
            {currentBranch ?? t("noBranch")}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-80 overflow-hidden">
        <Command className="rounded-2xl">
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
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
})
