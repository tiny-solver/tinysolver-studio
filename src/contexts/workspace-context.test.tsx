import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  WorkspaceProvider,
  useWorkspaceContext,
} from "@/contexts/workspace-context"
import * as api from "@/lib/api"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 1, path: "/repo", name: "repo" },
    activeFolderId: 1,
  }),
}))

vi.mock("@/lib/api", () => ({
  readFileForEdit: vi.fn(),
  readFileBase64: vi.fn(),
  readFilePreview: vi.fn(),
  gitIsTracked: vi.fn(),
  gitShowFile: vi.fn(),
  gitDiff: vi.fn(),
  gitDiffWithBranch: vi.fn(),
  gitShowDiff: vi.fn(),
  saveFileContent: vi.fn(),
}))

const mockedApi = api as unknown as {
  readFileForEdit: ReturnType<typeof vi.fn>
  gitIsTracked: ReturnType<typeof vi.fn>
  gitShowFile: ReturnType<typeof vi.fn>
}

function WorkspaceProbe() {
  const {
    mode,
    activePane,
    fileTabs,
    activeFileTabId,
    filesMaximized,
    openSessionFileDiff,
    closeFileTab,
    closeAllFileTabs,
    toggleFilesMaximized,
  } = useWorkspaceContext()

  return (
    <div>
      <output data-testid="mode">{mode}</output>
      <output data-testid="file-tab-count">{fileTabs.length}</output>
      <output data-testid="active-pane">{activePane}</output>
      <output data-testid="files-maximized">{String(filesMaximized)}</output>
      <output data-testid="active-file-tab">{activeFileTabId ?? "none"}</output>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/app.ts", "diff --git", "Turn 1")
        }
      >
        Open diff
      </button>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/other.ts", "diff --git", "Turn 1")
        }
      >
        Open diff 2
      </button>
      <button
        type="button"
        onClick={() => activeFileTabId && closeFileTab(activeFileTabId)}
      >
        Close active
      </button>
      <button type="button" onClick={closeAllFileTabs}>
        Close all
      </button>
      <button type="button" onClick={toggleFilesMaximized}>
        Toggle maximize
      </button>
    </div>
  )
}

function renderWorkspace() {
  return render(
    <WorkspaceProvider>
      <WorkspaceProbe />
    </WorkspaceProvider>
  )
}

describe("WorkspaceProvider mode", () => {
  it("derives conversation mode from an empty file workspace", () => {
    localStorage.setItem("workspace:mode", JSON.stringify({ mode: "files" }))

    renderWorkspace()

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("derives fusion mode while file tabs are open and returns to conversation when they close", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })
})

describe("WorkspaceProvider files-maximized", () => {
  it("toggles filesMaximized only while files are open", () => {
    renderWorkspace()

    // No files yet — toggling should not enable maximize (derived value gated
    // on fusion mode).
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Open a file, then toggle: maximize flips on, then off.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("does not mutate active pane on maximize toggle, preserving revert semantics", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    // Opening a file routes activePane to "files".
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    // Maximize must not silently rewrite the user's last-active pane.
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when all file tabs close, and does not leak into newly reopened files", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Reopening a file must start from the normal split, not a stale maximized
    // layout.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when the last tab is closed individually", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close active" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("does not touch file tab data when toggling maximize", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
      screen.getByRole("button", { name: "Open diff 2" }).click()
    })
    const tabCountBefore =
      screen.getByTestId("file-tab-count").textContent ?? ""
    const activeBefore = screen.getByTestId("active-file-tab").textContent ?? ""

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )
  })
})

interface CapturedTab {
  content: string
  loading: boolean
  saveState?: string
}

function FilePreviewProbe({
  onCapture,
}: {
  onCapture?: (tab: CapturedTab | null) => void
}) {
  const { openFilePreview, activeFileTab } = useWorkspaceContext()
  const snapshot: CapturedTab | null = activeFileTab
    ? {
        content: activeFileTab.content,
        loading: activeFileTab.loading,
        saveState: activeFileTab.saveState,
      }
    : null
  onCapture?.(snapshot)
  return (
    <div>
      <output data-testid="content">{activeFileTab?.content ?? ""}</output>
      <output data-testid="loading">
        {String(activeFileTab?.loading ?? false)}
      </output>
      <output data-testid="save-state">
        {activeFileTab?.saveState ?? "none"}
      </output>
      <button onClick={() => void openFilePreview("a.ts")}>open</button>
      <button onClick={() => void openFilePreview("a.ts", { reload: true })}>
        reload
      </button>
    </div>
  )
}

describe("openFilePreview cache semantics", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("activates an already-loaded tab without refetching", async () => {
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "hello",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    render(
      <WorkspaceProvider>
        <FilePreviewProbe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(screen.getByTestId("content")).toHaveTextContent("hello")
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    // Second click on the same file — pure cache hit.
    await act(async () => {
      screen.getByText("open").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("loading")).toHaveTextContent("false")
    expect(screen.getByTestId("content")).toHaveTextContent("hello")
  })

  it("forces refetch when reload: true and preserves content during fetch", async () => {
    let resolveSecond:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockImplementationOnce(() => new Promise((res) => (resolveSecond = res)))

    let captured = null as CapturedTab | null
    render(
      <WorkspaceProvider>
        <FilePreviewProbe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured).toMatchObject({ content: "v1", loading: false })

    await act(async () => {
      screen.getByText("reload").click()
    })
    // Mid-fetch: content preserved, loading true.
    expect(captured).toMatchObject({ content: "v1", loading: true })

    await act(async () => {
      resolveSecond!({
        path: "a.ts",
        content: "v2",
        etag: "e2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })
    })
    expect(captured).toMatchObject({ content: "v2", loading: false })
  })

  it("deduplicates concurrent opens of the same path", async () => {
    let resolveFirst:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit.mockImplementationOnce(
      () => new Promise((res) => (resolveFirst = res))
    )

    render(
      <WorkspaceProvider>
        <FilePreviewProbe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
      screen.getByText("open").click()
      screen.getByText("open").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst!({
        path: "a.ts",
        content: "x",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    })
  })

  it("retries after an error and clears the error state", async () => {
    mockedApi.readFileForEdit
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "ok",
        etag: "e",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })

    let captured = null as CapturedTab | null
    render(
      <WorkspaceProvider>
        <FilePreviewProbe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured?.saveState).toBe("error")

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured).toMatchObject({
      content: "ok",
      loading: false,
      saveState: "idle",
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(2)
  })

  it("does not resurrect a closed tab when reload: true arrives late", async () => {
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    function Probe() {
      const { openFilePreview, fileTabs, activeFileTabId, closeAllFileTabs } =
        useWorkspaceContext()
      return (
        <div>
          <output data-testid="tab-count">{fileTabs.length}</output>
          <output data-testid="active-id">{activeFileTabId ?? "none"}</output>
          <button onClick={() => void openFilePreview("a.ts")}>open</button>
          <button
            onClick={() => void openFilePreview("a.ts", { reload: true })}
          >
            reload
          </button>
          <button onClick={closeAllFileTabs}>close all</button>
        </div>
      )
    }

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("1")

    await act(async () => {
      screen.getByText("close all").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("0")

    // Simulate a watcher-driven reload that lands after the user closed
    // the tab. The reload should be a no-op — never create a phantom tab.
    await act(async () => {
      screen.getByText("reload").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-id")).toHaveTextContent("none")
    // The closed-and-reload sequence triggered only the initial open.
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
  })

  it("clears in-flight tracking on close so reopen is not falsely deduped", async () => {
    let resolveFirst:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v2",
        etag: "e2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })

    let captured = null as CapturedTab | null
    function Probe({
      onCapture,
    }: {
      onCapture: (tab: CapturedTab | null) => void
    }) {
      const { openFilePreview, activeFileTab, closeAllFileTabs } =
        useWorkspaceContext()
      onCapture(
        activeFileTab
          ? {
              content: activeFileTab.content,
              loading: activeFileTab.loading,
              saveState: activeFileTab.saveState,
            }
          : null
      )
      return (
        <div>
          <button onClick={() => void openFilePreview("a.ts")}>open</button>
          <button onClick={closeAllFileTabs}>close all</button>
        </div>
      )
    }

    render(
      <WorkspaceProvider>
        <Probe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    // Start a load and immediately close (load is still pending).
    await act(async () => {
      screen.getByText("open").click()
    })
    await act(async () => {
      screen.getByText("close all").click()
    })

    // Reopen — the stale in-flight marker should have been cleared, so
    // the second fetch must run and populate content (not get deduped).
    await act(async () => {
      screen.getByText("open").click()
    })

    // Drain the original (now-orphaned) fetch — it should no-op since
    // its target tab id was removed during close.
    await act(async () => {
      resolveFirst!({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    })

    expect(captured).toMatchObject({ content: "v2", loading: false })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(2)
  })
})
