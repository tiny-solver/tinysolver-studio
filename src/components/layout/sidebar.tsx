"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  EllipsisVertical,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useSidebarContext } from "@/contexts/sidebar-context"
import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "@/components/conversations/sidebar-conversation-list"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  loadShowCompleted,
  loadSortMode,
  saveShowCompleted,
  saveSortMode,
  type SidebarSortMode,
} from "@/lib/sidebar-view-mode-storage"

export function Sidebar() {
  const t = useTranslations("Folder.sidebar")
  const { isOpen, toggle } = useSidebarContext()
  const isMobile = useIsMobile()
  const listRef = useRef<SidebarConversationListHandle>(null)

  const [showCompleted, setShowCompleted] = useState(false)
  const [sortMode, setSortMode] = useState<SidebarSortMode>("created")
  const [allExpanded, setAllExpanded] = useState(true)

  useEffect(() => {
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowCompleted(loadShowCompleted())
    setSortMode(loadSortMode())
  }, [])

  const handleSetShowCompleted = useCallback((value: boolean) => {
    setShowCompleted(value)
    saveShowCompleted(value)
  }, [])

  const handleSetSortMode = useCallback((value: string) => {
    const mode: SidebarSortMode = value === "updated" ? "updated" : "created"
    setSortMode(mode)
    saveSortMode(mode)
  }, [])

  const handleToggleExpandAll = useCallback(() => {
    if (allExpanded) {
      listRef.current?.collapseAll()
      setAllExpanded(false)
    } else {
      listRef.current?.expandAll()
      setAllExpanded(true)
    }
  }, [allExpanded])

  if (!isOpen) return null

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none">
      <TooltipProvider>
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border pl-4 pr-2">
          <div className="flex min-w-0 items-baseline gap-[0.375rem]">
            <h2 className="truncate text-[0.875rem] font-bold tracking-[-0.00625rem] text-sidebar-foreground">
              {t("title")}
            </h2>
          </div>
          <div className="flex items-center gap-0.5">
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
              onClick={handleToggleExpandAll}
              title={
                allExpanded ? t("collapseAllGroups") : t("expandAllGroups")
              }
            >
              {allExpanded ? (
                <ChevronsDownUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronsUpDown className="h-3.5 w-3.5" />
              )}
            </Button>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground"
                    >
                      <EllipsisVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("moreOptions")}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={showCompleted}
                  onCheckedChange={handleSetShowCompleted}
                >
                  {t("showCompleted")}
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("sortBy")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={sortMode}
                  onValueChange={handleSetSortMode}
                >
                  <DropdownMenuRadioItem value="created">
                    {t("sortByCreatedAt")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="updated">
                    {t("sortByUpdatedAt")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </TooltipProvider>

      {/* On mobile, clicking a conversation card auto-closes the Sheet */}
      <div
        className="flex flex-col flex-1 min-h-0 overflow-hidden pt-1"
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
          showCompleted={showCompleted}
          sortMode={sortMode}
        />
      </div>
    </aside>
  )
}
