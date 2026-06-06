import { type ReactNode, useEffect, useState } from "react"
import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SidebarConversationList } from "./sidebar-conversation-list"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// ── Probes ────────────────────────────────────────────────────────────────
// AgentIcon renders once per card body → counts card re-renders.
// useDragControls runs once per FolderGroupItem body → counts folder
// re-renders. Both increment only when the owning memoized component does NOT
// bail out, so they measure exactly the production memo path.
const probes = vi.hoisted(() => ({ card: 0, folder: 0 }))

// Mutable backing store the mocked context hooks read from. Function refs are
// stable across renders (as the real providers' useCallback values are); only
// `conversations` and `tabs` churn — `tabs` is rebuilt fresh every render to
// mirror tab-context re-deriving it on each `conversations` change.
const store = vi.hoisted(() => ({
  conversations: [] as unknown[],
  folders: [] as unknown[],
  allFolders: [] as unknown[],
  activeTabId: null as string | null,
  tabSpec: [] as Array<{
    id: string
    conversationId: number | null
    agentType: string
    folderId: number
    title: string
    isPinned: boolean
  }>,
}))

const stableWorkspaceFns = vi.hoisted(() => ({
  refreshConversations: () => {},
  updateConversationLocal: () => {},
  removeFolderFromWorkspace: () => {},
  reorderFolders: () => {},
  openFolder: () => {},
  refreshFolder: () => {},
}))

const stableTabFns = vi.hoisted(() => ({
  openTab: () => {},
  closeConversationTab: () => {},
  closeTabsByFolder: () => {},
  openNewConversationTab: () => {},
}))

const stableAgents = vi.hoisted(() => ({ sortedTypes: ["claude_code"] }))

// Context functions are stable refs in production (useCallback values); the
// mocks must be too, else the list's folder callbacks (which close over them)
// would churn and mask the memo behaviour under test.
const stableTask = vi.hoisted(() => ({
  addTask: () => {},
  updateTask: () => {},
}))
const stableTerminal = vi.hoisted(() => ({
  createTerminalInDirectory: () => {},
}))

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => {
    probes.card++
    return null
  },
}))

vi.mock("motion/react", () => ({
  Reorder: {
    Group: ({ children }: { children?: ReactNode }) => children,
    Item: ({ children }: { children?: ReactNode }) => children,
  },
  useDragControls: () => {
    probes.folder++
    return { start: () => {} }
  },
}))

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => children,
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

vi.mock("@/hooks/use-appearance", () => ({
  useThemeColor: () => ({ themeColor: "blue" }),
  useZoomLevel: () => {},
}))

vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: stableAgents.sortedTypes,
    fresh: true,
    refresh: () => {},
  }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => stableTerminal,
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => stableTask,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

vi.mock("@/contexts/app-workspace-context", () => ({
  useAppWorkspace: () => ({
    folders: store.folders,
    allFolders: store.allFolders,
    conversations: store.conversations,
    conversationsLoading: false,
    conversationsError: null,
    ...stableWorkspaceFns,
  }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabContext: () => ({
    ...stableTabFns,
    activeTabId: store.activeTabId,
    // Fresh array + fresh objects every render → worst-case churn, exactly what
    // the list's reuseSelected/reuseSet must absorb to keep folders memoized.
    tabs: store.tabSpec.map((t) => ({ ...t })),
  }),
}))

// These only mount when their state opens (never in these tests); stub to keep
// the import graph light.
vi.mock("./conversation-manage-dialog", () => ({
  ConversationManageDialog: () => null,
}))
vi.mock("@/components/layout/clone-dialog", () => ({ CloneDialog: () => null }))
vi.mock("@/components/shared/directory-browser-dialog", () => ({
  DirectoryBrowserDialog: () => null,
}))

const MINUTE = 60_000
const FIXED = 1_700_000_000_000

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const createdAt = new Date(FIXED - 5 * MINUTE).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    agent_type: "claude_code",
    status: "pending",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
}

function folder(id: number, name: string): FolderDetail {
  return {
    id,
    name,
    path: `/p/${id}`,
    color: "blue",
    default_agent_type: null,
  } as unknown as FolderDetail
}

// Re-render only the list, leaving the intl provider mounted once — mirrors
// production, where NextIntlClientProvider sits high in the tree and stays
// stable (so `useTranslations` returns a stable `t`) while the list re-renders
// on each conversations change.
const harness: { rerender: () => void } = { rerender: () => {} }
function Harness() {
  const [, setTick] = useState(0)
  useEffect(() => {
    harness.rerender = () => setTick((n) => n + 1)
  }, [])
  return <SidebarConversationList showCompleted sortMode="created" />
}

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness />
    </NextIntlClientProvider>
  )
}

describe("SidebarConversationList — single status event re-render scope", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED })
    probes.card = 0
    probes.folder = 0
    store.folders = [folder(1, "Folder 1"), folder(2, "Folder 2")]
    store.allFolders = store.folders
    store.conversations = [
      conv(11, 1),
      conv(12, 1),
      conv(21, 2),
      conv(22, 2),
      conv(23, 2),
    ]
    // One open tab in folder 1 → exercises the selectedConversation object and
    // openTabKeys Set reuse paths (these churn refs every render via the mock).
    store.activeTabId = "tab-11"
    store.tabSpec = [
      {
        id: "tab-11",
        conversationId: 11,
        agentType: "claude_code",
        folderId: 1,
        title: "conv-11",
        isPinned: false,
      },
    ]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("re-renders exactly one card and one folder when a single summary changes", () => {
    render(tree())

    // Sanity: initial mount rendered all 5 cards and both folders.
    expect(probes.card).toBe(5)
    expect(probes.folder).toBe(2)

    // Mirror updateConversationLocal: replace exactly one summary (folder 2,
    // conv 22) with a new object; every other summary keeps its identity.
    const prev = store.conversations as DbConversationSummary[]
    const next = prev.slice()
    const idx = next.findIndex((c) => c.id === 22)
    next[idx] = { ...next[idx], status: "completed" }
    store.conversations = next

    probes.card = 0
    probes.folder = 0
    act(() => harness.rerender())

    // Card-level gate: only the changed card re-renders (R1 + R1b + shared now).
    expect(probes.card).toBe(1)
    // Folder-level skip: folder 1 stays memoized despite the tabs ref churn;
    // only folder 2 (whose bucket array changed) re-runs its map (R3 + R5).
    expect(probes.folder).toBe(1)
  })

  it("re-renders nothing when conversations are unchanged despite tab churn", () => {
    render(tree())

    probes.card = 0
    probes.folder = 0
    // Same conversations reference; tabs still churns (fresh array each render).
    act(() => harness.rerender())

    expect(probes.card).toBe(0)
    expect(probes.folder).toBe(0)
  })
})
