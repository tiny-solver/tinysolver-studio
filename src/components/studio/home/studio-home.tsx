"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  MessageSquare,
  PanelRightClose,
  Maximize2,
  Minimize2,
} from "lucide-react"

import { ConversationDetailPanel } from "@/components/conversations/conversation-detail-panel"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { readContentProject, studioRun } from "@/lib/api"
import { parseFlow, type StudioFlow } from "@/lib/studio/flow"
import { useTabStore } from "@/stores/tab-store"
import { CreateStart } from "./create-start"
import { FlowBoard } from "./flow-board"
import "./studio-home.css"

const DRAWER_KEY = "tinysolver.home.drawer"

type Drawer = "closed" | "open" | "wide"

function readDrawer(): Drawer {
  try {
    const v = localStorage.getItem(DRAWER_KEY)
    return v === "open" || v === "wide" ? v : "closed"
  } catch {
    return "closed"
  }
}

/**
 * The first screen (decide fs-layout A): "what shall we make?" and the step
 * cards it turns into, with the agent conversation in a drawer on the right.
 * It sits where the workspace used to put the conversation, inside every
 * workspace provider, so the drawer holds the very same conversation panel —
 * sidebar, tabs, agents and all — and nothing about chat is reimplemented.
 */
export function StudioHome() {
  const t = useTranslations("StudioHome")
  const { activeFolder } = useActiveFolder()
  const [drawer, setDrawerState] = useState<Drawer>(readDrawer)
  /** The project whose cards are shown; `null` → the start screen. */
  const [shown, setShown] = useState<{ root: string; flow: StudioFlow } | null>(
    null
  )
  /** Set while the person chose "make something new" over the open folder. */
  const [starting, setStarting] = useState(false)

  const setDrawer = useCallback((next: Drawer) => {
    setDrawerState(next)
    try {
      localStorage.setItem(DRAWER_KEY, next)
    } catch {
      // per-viewer convenience only
    }
  }, [])

  // Picking an existing conversation (sidebar, search, deep link) means the
  // person wants to read it: open the drawer. Tab restore at start-up also
  // moves the active tab, so changes in the first moments are not a pick.
  useEffect(() => {
    const mountedAt = Date.now()
    const conversationOf = (st: ReturnType<typeof useTabStore.getState>) => {
      const tab = st.tabs.find((x) => x.id === st.activeTabId)
      return tab && tab.kind === "conversation" && tab.conversationId != null
        ? tab.id
        : null
    }
    return useTabStore.subscribe((st, prev) => {
      const now = conversationOf(st)
      if (!now || now === conversationOf(prev)) return
      if (Date.now() - mountedAt < 2000) return
      setDrawerState((d) => (d === "closed" ? "open" : d))
    })
  }, [])

  // The open folder's flow, when it is a content project with one.
  const folderPath = activeFolder?.path ?? null
  useEffect(() => {
    if (!folderPath || starting) return
    let cancelled = false
    void (async () => {
      try {
        const manifest = await readContentProject(folderPath)
        if (!manifest) {
          if (!cancelled) setShown(null)
          return
        }
        const res = await studioRun<{ ok: boolean; flow?: unknown }>(
          folderPath,
          { op: "read_flow" }
        )
        const flow = res.ok ? parseFlow(res.flow) : null
        if (!cancelled) setShown(flow ? { root: folderPath, flow } : null)
      } catch {
        if (!cancelled) setShown(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [folderPath, starting])

  const main = useMemo(() => {
    if (shown && !starting)
      return (
        <FlowBoard
          key={shown.root}
          root={shown.root}
          initial={shown.flow}
          folderId={activeFolder?.path === shown.root ? activeFolder.id : null}
          onNew={() => setStarting(true)}
          onOpenChat={() => setDrawer("open")}
        />
      )
    return (
      <CreateStart
        onCreated={(root, flow) => {
          setStarting(false)
          setShown({ root, flow })
        }}
        onCancel={shown ? () => setStarting(false) : undefined}
      />
    )
  }, [shown, starting, activeFolder, setDrawer])

  return (
    <div className="studio-home" data-drawer={drawer}>
      <div className="studio-home-main">{main}</div>
      {drawer === "closed" ? (
        <button
          className="studio-home-drawer-handle"
          onClick={() => setDrawer("open")}
          title={t("drawer.open")}
          aria-label={t("drawer.open")}
        >
          <MessageSquare size={16} />
          <span>{t("drawer.title")}</span>
        </button>
      ) : null}
      {/* Kept mounted while closed so a running turn keeps streaming. */}
      <aside className="studio-home-drawer" aria-label={t("drawer.title")}>
        <div className="studio-home-drawer-bar">
          <strong>{t("drawer.title")}</strong>
          <button
            onClick={() => setDrawer(drawer === "wide" ? "open" : "wide")}
            title={drawer === "wide" ? t("drawer.narrow") : t("drawer.wide")}
            aria-label={
              drawer === "wide" ? t("drawer.narrow") : t("drawer.wide")
            }
          >
            {drawer === "wide" ? (
              <Minimize2 size={14} />
            ) : (
              <Maximize2 size={14} />
            )}
          </button>
          <button
            onClick={() => setDrawer("closed")}
            title={t("drawer.close")}
            aria-label={t("drawer.close")}
          >
            <PanelRightClose size={14} />
          </button>
        </div>
        <div className="studio-home-drawer-body">
          <ConversationDetailPanel />
        </div>
      </aside>
    </div>
  )
}
