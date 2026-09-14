import { act, render, waitFor, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

// The workspace half lives in the real zustand store: tests seed it via
// setState in beforeEach and flip hydration with act(setState). The tab half
// is still a mutable hook mock — the mock reads this module-level var, so
// reassigning + rerendering simulates the provider state changing.
let tabs: { tabsHydrated: boolean; openTab: ReturnType<typeof vi.fn> }
let addFolderToWorkspaceById: ReturnType<typeof vi.fn>
let capturedHandler: ((p: unknown) => void) | null = null
let takePendingDeepLink: ReturnType<typeof vi.fn>

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: typeof tabs) => unknown) => selector(tabs),
  useTabActions: () => tabs,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: async (_event: string, cb: (p: unknown) => void) => {
      capturedHandler = cb
      return () => {}
    },
  }),
}))
vi.mock("@/lib/deep-link", () => ({
  takePendingDeepLink: () => takePendingDeepLink(),
}))

import { PetFocusBridge } from "./deep-link-bootstrap"

describe("PetFocusBridge", () => {
  beforeEach(() => {
    capturedHandler = null
    takePendingDeepLink = vi.fn(async () => null)
    addFolderToWorkspaceById = vi.fn()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: false,
      folders: [{ id: 7 }] as never,
      addFolderToWorkspaceById,
    })
    tabs = { tabsHydrated: false, openTab: vi.fn() }
  })
  afterEach(() => cleanup())

  it("queues a request that arrives before hydration and replays it", async () => {
    const { rerender } = render(<PetFocusBridge />)
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    // Arrives before folders/tabs (and the independently-loading conversations
    // snapshot) are ready — must not be dropped.
    capturedHandler!({ folderId: 7, conversationId: 42, agent: "claude_code" })
    expect(tabs.openTab).not.toHaveBeenCalled()

    // Hydration completes → queued request replays.
    tabs = { ...tabs, tabsHydrated: true }
    rerender(<PetFocusBridge />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 42, "claude_code", true)
    )
  })

  it("opens immediately when already hydrated, without re-adding an open folder", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    capturedHandler!({ folderId: 7, conversationId: 9, agent: "codex" })
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 9, "codex", true)
    )
    expect(addFolderToWorkspaceById).not.toHaveBeenCalled()
  })

  // A `codeg://session/<id>` that reaches the backend before this component
  // subscribes (macOS cold start) is parked there, not emitted: Tauri drops an
  // event that has no registered listener yet.
  it("opens the tab for a deep link parked before it subscribed", async () => {
    takePendingDeepLink = vi.fn(async () => ({
      folderId: 7,
      conversationId: 314,
      agent: "grok",
    }))
    const { rerender } = render(<PetFocusBridge />)

    // Still queued while hydrating, exactly like a live request.
    await waitFor(() => expect(takePendingDeepLink).toHaveBeenCalled())
    expect(tabs.openTab).not.toHaveBeenCalled()

    tabs = { ...tabs, tabsHydrated: true }
    rerender(<PetFocusBridge />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 314, "grok", true)
    )
  })

  // The drain runs on every mount so a warm-start link can't leave a target
  // behind — but the event it was emitted alongside wins if it got here first.
  it("drains without clobbering a request the live event already queued", async () => {
    let release: (v: null) => void = () => {}
    takePendingDeepLink = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = resolve
        })
    )
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    capturedHandler!({ folderId: 7, conversationId: 42, agent: "codex" })
    await act(async () => {
      release(null)
    })

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 42, "codex", true)
    )
    expect(tabs.openTab).toHaveBeenCalledTimes(1)
  })

  it("ignores malformed payloads", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(capturedHandler).toBeTruthy())

    capturedHandler!({ folderId: "x", conversationId: 1, agent: "codex" })
    capturedHandler!({ folderId: 7, conversationId: 1 }) // missing agent
    await Promise.resolve()
    expect(tabs.openTab).not.toHaveBeenCalled()
  })
})
