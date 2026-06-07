"use client"

import { memo, useState, useCallback } from "react"
import {
  Pencil,
  Trash2,
  Circle,
  Plus,
  GitBranch,
  FolderGit2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import type { DbConversationSummary, ConversationStatus } from "@/lib/types"
import { STATUS_ORDER } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConversationStatusDot } from "./conversation-status-dot"
import { AgentIcon } from "@/components/agent-icon"

interface SidebarConversationCardProps {
  conversation: DbConversationSummary
  isSelected: boolean
  isOpenInTab?: boolean
  /** True when this conversation's folder is a worktree (folder.parent_id set);
   * selects the worktree branch icon instead of the plain branch icon. */
  isWorktreeBranch?: boolean
  timeLabel?: string
  onSelect: (id: number, agentType: string, folderId: number) => void
  onDoubleClick?: (id: number, agentType: string, folderId: number) => void
  onRename: (id: number, newTitle: string) => Promise<void>
  onDelete: (id: number, agentType: string, folderId: number) => Promise<void>
  onStatusChange: (id: number, status: ConversationStatus) => Promise<void>
  onNewConversation?: (folderId: number) => void
}

export const SidebarConversationCard = memo(function SidebarConversationCard({
  conversation,
  isSelected,
  isOpenInTab = false,
  isWorktreeBranch = false,
  timeLabel,
  onSelect,
  onDoubleClick,
  onRename,
  onDelete,
  onStatusChange,
  onNewConversation,
}: SidebarConversationCardProps) {
  const t = useTranslations("Folder.conversationCard")
  const tSidebar = useTranslations("Folder.sidebar")
  const tStatus = useTranslations("Folder.statusLabels")
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")

  const handleClick = useCallback(() => {
    onSelect(conversation.id, conversation.agent_type, conversation.folder_id)
  }, [
    onSelect,
    conversation.id,
    conversation.agent_type,
    conversation.folder_id,
  ])

  const handleDblClick = useCallback(() => {
    onDoubleClick?.(
      conversation.id,
      conversation.agent_type,
      conversation.folder_id
    )
  }, [
    onDoubleClick,
    conversation.id,
    conversation.agent_type,
    conversation.folder_id,
  ])

  const handleRenameOpen = useCallback(() => {
    setRenameValue(conversation.title || "")
    setRenameOpen(true)
  }, [conversation.title])

  const handleRenameConfirm = useCallback(async () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== conversation.title) {
      await onRename(conversation.id, trimmed)
    }
    setRenameOpen(false)
  }, [renameValue, conversation.id, conversation.title, onRename])

  const handleDeleteConfirm = useCallback(async () => {
    await onDelete(
      conversation.id,
      conversation.agent_type,
      conversation.folder_id
    )
    setDeleteOpen(false)
  }, [
    conversation.id,
    conversation.agent_type,
    conversation.folder_id,
    onDelete,
  ])

  const status = conversation.status as ConversationStatus
  const isRunning = status === "in_progress"
  const isCancelled = status === "cancelled"
  const BranchIcon = isWorktreeBranch ? FolderGit2 : GitBranch

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative bg-sidebar"
            data-conv-key={`${conversation.agent_type}:${conversation.id}`}
          >
            <button
              data-conversation-id={conversation.id}
              onClick={handleClick}
              onDoubleClick={handleDblClick}
              className={cn(
                "flex w-full flex-col gap-[0.1875rem] px-2 py-[0.3125rem] text-left outline-none",
                "rounded-[0.625rem] text-sidebar-foreground",
                "transition-colors duration-[120ms]",
                isSelected
                  ? "bg-sidebar-primary/8"
                  : "hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_2%)]"
              )}
            >
              {/* Line 1 — title */}
              <span
                className={cn(
                  "min-w-0 max-w-full truncate text-[0.875rem] font-normal leading-tight",
                  isOpenInTab && "text-primary"
                )}
              >
                {conversation.title || t("untitledConversation")}
              </span>

              {/* Line 2 — agent icon · branch · time */}
              <span className="flex w-full items-center gap-[0.375rem]">
                <span
                  className="relative flex h-[0.875rem] w-[0.875rem] shrink-0 items-center justify-center"
                  aria-hidden
                >
                  <AgentIcon
                    agentType={conversation.agent_type}
                    className="h-[0.75rem] w-[0.75rem]"
                  />
                  <ConversationStatusDot
                    status={status}
                    size="sm"
                    className="absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar"
                  />
                </span>

                {conversation.git_branch ? (
                  <span className="flex min-w-0 flex-1 items-center gap-[0.1875rem] text-[0.71875rem] text-muted-foreground/70">
                    <BranchIcon className="h-[0.6875rem] w-[0.6875rem] shrink-0" />
                    <span className="min-w-0 truncate">
                      {conversation.git_branch}
                    </span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1" />
                )}

                {isRunning ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center",
                      "h-[0.9375rem] rounded-[0.3125rem] px-[0.25rem]",
                      "text-[0.625rem] font-semibold leading-none tracking-[0.01875rem]",
                      "bg-amber-500/20 text-amber-600 dark:bg-amber-400/20 dark:text-amber-400"
                    )}
                  >
                    {tSidebar("statusRunningBadge")}
                  </span>
                ) : isCancelled ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center justify-center",
                      "h-[0.9375rem] rounded-[0.3125rem] px-[0.25rem]",
                      "text-[0.625rem] font-semibold leading-none tracking-[0.01875rem]",
                      "bg-destructive/20 text-destructive"
                    )}
                  >
                    {tSidebar("statusCancelledBadge")}
                  </span>
                ) : timeLabel ? (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-[0.71875rem]",
                      isSelected
                        ? "font-medium text-muted-foreground"
                        : "font-normal text-muted-foreground/70"
                    )}
                  >
                    {timeLabel}
                  </span>
                ) : null}
              </span>
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onNewConversation && (
            <>
              <ContextMenuItem
                onSelect={() => onNewConversation(conversation.folder_id)}
              >
                <Plus className="h-4 w-4" />
                {t("newConversation")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onSelect={handleRenameOpen}>
            <Pencil className="h-4 w-4" />
            {t("rename")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Circle className="h-4 w-4" />
              {t("status")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {STATUS_ORDER.filter((s) => s !== conversation.status).map(
                (s) => (
                  <ContextMenuItem
                    key={s}
                    onSelect={() => onStatusChange(conversation.id, s)}
                  >
                    <ConversationStatusDot status={s} />
                    {tStatus(s)}
                  </ContextMenuItem>
                )
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t("delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameConversation")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.key === "Process") return
              if (e.key === "Enter") handleRenameConfirm()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleRenameConfirm}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConversationTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConversationDescription", {
                title: conversation.title || t("untitledConversation"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
})
