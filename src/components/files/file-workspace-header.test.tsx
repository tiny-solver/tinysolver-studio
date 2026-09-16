import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"

const mocks = vi.hoisted(() => ({
  activeFileTab: null as FileWorkspaceTab | null,
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => ({
    activeFileTab: mocks.activeFileTab,
    activeFileTabId: mocks.activeFileTab?.id ?? null,
    previewFileTabIds: new Set<string>(),
  }),
  useWorkspaceActions: () => ({ toggleFileTabPreview: vi.fn() }),
}))
vi.mock("@/components/files/file-path-breadcrumb", () => ({
  FilePathBreadcrumb: ({ fileName }: { fileName: string }) => (
    <span>{fileName}</span>
  ),
}))
vi.mock("@/lib/platform", () => ({ openPath: vi.fn() }))

import { FileWorkspaceHeader } from "./file-workspace-header"

function renderHeader() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FileWorkspaceHeader />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.activeFileTab = null
})

describe("FileWorkspaceHeader", () => {
  it("names the active file", () => {
    mocks.activeFileTab = {
      id: "file:/repo/a.ts",
      kind: "file",
      folderId: null,
      title: "a.ts",
      description: "/repo/a.ts",
      path: "/repo/a.ts",
      language: "typescript",
      content: "",
      loading: false,
    } as FileWorkspaceTab
    const { container } = renderHeader()
    expect(screen.getByText("a.ts")).toBeInTheDocument()
    expect(container.firstChild).not.toBeNull()
  })

  it("self-hides for a browser tab, whose toolbar is its own header", () => {
    // Two rows of chrome above a web page is one too many: the page title is
    // already on the tab, and the toolbar below names the page better. Every
    // action this header carries is `kind: "file"` only, so nothing is lost.
    mocks.activeFileTab = {
      id: "browser:abc",
      kind: "browser",
      folderId: null,
      title: "Example",
      description: null,
      path: null,
      language: "browser",
      content: "",
      loading: false,
      readonly: true,
      browser: {
        initialUrl: "https://example.com/",
        openerTabId: null,
        profile: "default",
      },
    } as FileWorkspaceTab
    const { container } = renderHeader()
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText("Example")).toBeNull()
  })

  it("renders nothing with no active tab", () => {
    const { container } = renderHeader()
    expect(container.firstChild).toBeNull()
  })
})
