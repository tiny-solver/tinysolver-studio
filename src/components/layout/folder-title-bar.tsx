"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import {
  Columns2,
  FileCode2,
  MessageSquare,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { getGitBranch, openFolderWindow, openSettingsWindow } from "@/lib/api"
import { openFileDialog } from "@/lib/platform"
import { useFolderContext } from "@/contexts/folder-context"
import { Button } from "@/components/ui/button"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useTabContext } from "@/contexts/tab-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import { useIsMac } from "@/hooks/use-is-mac"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  formatShortcutLabel,
  matchShortcutEvent,
} from "@/lib/keyboard-shortcuts"
import { AppTitleBar } from "./app-title-bar"
import { FolderNameDropdown } from "./folder-name-dropdown"
import { BranchDropdown } from "./branch-dropdown"
import { CommandDropdown } from "./command-dropdown"
import { SearchCommandDialog } from "@/components/conversations/search-command-dialog"
import { cn } from "@/lib/utils"

const MODE_TABS = [
  {
    mode: "conversation",
    titleKey: "conversation",
    icon: MessageSquare,
  },
  {
    mode: "fusion",
    titleKey: "fusion",
    icon: Columns2,
  },
  {
    mode: "files",
    titleKey: "files",
    icon: FileCode2,
  },
] as const

export function FolderTitleBar() {
  const tModes = useTranslations("Folder.modes")
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const { folder } = useFolderContext()
  const { isOpen, toggle } = useSidebarContext()
  const { isOpen: auxPanelOpen, toggle: toggleAuxPanel } = useAuxPanelContext()
  const { isOpen: terminalOpen, toggle: toggleTerminal } = useTerminalContext()
  const { openNewConversationTab } = useTabContext()
  const { mode, setMode } = useWorkspaceContext()
  const isMac = useIsMac()
  const { shortcuts } = useShortcutSettings()
  const [branch, setBranch] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined
  )

  const folderPath = folder?.path ?? ""

  const handleOpenFolder = useCallback(async () => {
    try {
      const result = await openFileDialog({ directory: true, multiple: false })
      if (!result) return
      const selected = Array.isArray(result) ? result[0] : result
      await openFolderWindow(selected)
    } catch (err) {
      console.error("[FolderTitleBar] failed to open folder:", err)
    }
  }, [])

  const handleOpenSettings = useCallback(() => {
    openSettingsWindow().catch((err) => {
      console.error("[FolderTitleBar] failed to open settings:", err)
    })
  }, [])

  useEffect(() => {
    if (!folderPath) return
    let cancelled = false

    async function doFetch() {
      if (document.visibilityState !== "visible") return

      try {
        const b = await getGitBranch(folderPath)
        if (!cancelled) setBranch(b)
      } catch {
        if (!cancelled) setBranch(null)
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void doFetch()
      }
    }

    void doFetch()
    intervalRef.current = setInterval(() => {
      void doFetch()
    }, 10_000)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(intervalRef.current)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [folderPath])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchShortcutEvent(e, shortcuts.toggle_search)) {
        e.preventDefault()
        setSearchOpen((prev) => !prev)
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_sidebar)) {
        e.preventDefault()
        toggle()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_terminal)) {
        e.preventDefault()
        toggleTerminal()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_aux_panel)) {
        e.preventDefault()
        toggleAuxPanel()
        return
      }
      if (matchShortcutEvent(e, shortcuts.new_conversation)) {
        if (!folderPath) return
        e.preventDefault()
        openNewConversationTab(folderPath)
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_folder)) {
        e.preventDefault()
        void handleOpenFolder()
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_settings)) {
        e.preventDefault()
        handleOpenSettings()
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [
    folderPath,
    handleOpenFolder,
    handleOpenSettings,
    openNewConversationTab,
    shortcuts,
    toggle,
    toggleAuxPanel,
    toggleTerminal,
  ])

  const refreshBranch = useCallback(async () => {
    if (!folderPath) return
    try {
      setBranch(await getGitBranch(folderPath))
    } catch {
      setBranch(null)
    }
  }, [folderPath])
  const modeContainerRef = useRef<HTMLDivElement>(null)
  const modeItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [modeIndicator, setModeIndicator] = useState<{
    left: number
    width: number
  } | null>(null)

  useEffect(() => {
    const container = modeContainerRef.current
    if (!container) return

    const measure = () => {
      const btn = modeItemRefs.current.get(mode)
      if (!btn || !container) {
        setModeIndicator(null)
        return
      }
      const containerRect = container.getBoundingClientRect()
      const btnRect = btn.getBoundingClientRect()
      setModeIndicator({
        left: btnRect.left - containerRect.left,
        width: btnRect.width,
      })
    }

    const ro = new ResizeObserver(() => measure())
    for (const btn of modeItemRefs.current.values()) {
      ro.observe(btn)
    }
    ro.observe(container)
    measure()

    return () => {
      ro.disconnect()
    }
  }, [mode])

  const handleModeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, nextMode: typeof mode) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        setMode(nextMode)
      }
    },
    [setMode]
  )

  return (
    <>
      <AppTitleBar
        centerInteractive
        left={
          <div className="flex items-center gap-4 min-w-0 pl-4">
            <FolderNameDropdown />
            <BranchDropdown
              branch={branch}
              parentBranch={folder?.parent_branch ?? null}
              onBranchChange={refreshBranch}
            />
            <div data-tauri-drag-region className="h-8 flex-1" />
          </div>
        }
        center={
          <div
            ref={modeContainerRef}
            role="tablist"
            aria-label={tModes("workspaceModesAria")}
            className="relative inline-flex h-[27px] items-center rounded-full border border-border/50 bg-muted/50 p-0.5"
          >
            {modeIndicator && (
              <div
                className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-full bg-background shadow-sm ring-1 ring-border/50 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
                style={{
                  left: modeIndicator.left,
                  width: modeIndicator.width,
                }}
              />
            )}
            {MODE_TABS.map((item) => {
              const Icon = item.icon
              const isActive = mode === item.mode
              const title = tModes(item.titleKey)
              return (
                <div
                  key={item.mode}
                  ref={(el) => {
                    if (el) {
                      modeItemRefs.current.set(item.mode, el)
                    } else {
                      modeItemRefs.current.delete(item.mode)
                    }
                  }}
                  role="tab"
                  tabIndex={0}
                  className={cn(
                    "relative z-10 m-0 flex h-[23px] cursor-pointer select-none items-center justify-center gap-1 rounded-full border-0 bg-transparent p-0 align-middle text-xs font-medium leading-none transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    isActive ? "px-2.5" : "px-2",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground/70"
                  )}
                  onClick={() => setMode(item.mode)}
                  onKeyDown={(event) => handleModeKeyDown(event, item.mode)}
                  onMouseDown={(event) => event.preventDefault()}
                  title={!isActive ? title : undefined}
                  aria-label={title}
                  aria-selected={isActive}
                >
                  <Icon
                    className="block h-3 w-3 shrink-0"
                    shapeRendering="geometricPrecision"
                  />
                  <span
                    className={cn(
                      "overflow-hidden whitespace-nowrap transition-all duration-300",
                      isActive
                        ? "max-w-[60px] opacity-100"
                        : "max-w-0 opacity-0"
                    )}
                  >
                    {title}
                  </span>
                </div>
              )
            })}
          </div>
        }
        right={
          <div className="flex items-center gap-10">
            <div className="flex items-center gap-2">
              <CommandDropdown />
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:text-foreground/80"
                onClick={toggle}
                title={tTitleBar("withShortcut", {
                  label: tTitleBar(isOpen ? "hideSidebar" : "showSidebar"),
                  shortcut: formatShortcutLabel(
                    shortcuts.toggle_sidebar,
                    isMac
                  ),
                })}
              >
                <PanelLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 hover:text-foreground/80 ${terminalOpen ? "bg-accent" : ""}`}
                onClick={() => toggleTerminal()}
                title={tTitleBar("withShortcut", {
                  label: tTitleBar("toggleTerminal"),
                  shortcut: formatShortcutLabel(
                    shortcuts.toggle_terminal,
                    isMac
                  ),
                })}
              >
                <PanelBottom className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 hover:text-foreground/80 ${auxPanelOpen ? "bg-accent" : ""}`}
                onClick={toggleAuxPanel}
                title={tTitleBar("withShortcut", {
                  label: tTitleBar("toggleAuxPanel"),
                  shortcut: formatShortcutLabel(
                    shortcuts.toggle_aux_panel,
                    isMac
                  ),
                })}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:text-foreground/80"
                onClick={() => setSearchOpen(true)}
                title={tTitleBar("withShortcut", {
                  label: tTitleBar("search"),
                  shortcut: formatShortcutLabel(shortcuts.toggle_search, isMac),
                })}
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:text-foreground/80"
                onClick={handleOpenSettings}
                title={tTitleBar("withShortcut", {
                  label: tTitleBar("openSettings"),
                  shortcut: formatShortcutLabel(shortcuts.open_settings, isMac),
                })}
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        }
      />
      <SearchCommandDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}
