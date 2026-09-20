import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isRemoteDesktopWindow: vi.fn(() => false),
}))

vi.mock("@/lib/platform", () => ({
  isRemoteDesktopWindow: mocks.isRemoteDesktopWindow,
}))

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

import { OpenInSubContent } from "./open-in-menu"

const handlers = {
  onOpenExplorer: vi.fn(),
  onOpenTerminal: vi.fn(),
  onOpenCode: vi.fn(),
}

function renderMenu(
  explorerDisabled?: boolean,
  onOpenStudio?: () => void,
  onOpenBrowser?: () => void
) {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="target">folder</ContextMenuTrigger>
      <ContextMenuContent>
        {/* The submenu is pinned open: the row's disabled state is what's
            under test, not Radix's hover-to-open choreography. */}
        <ContextMenuSub open>
          <ContextMenuSubTrigger>Open in</ContextMenuSubTrigger>
          <OpenInSubContent
            explorerLabel="Explorer"
            terminalLabel="Terminal"
            codeLabel="VS Code"
            explorerDisabled={explorerDisabled}
            studioLabel={onOpenStudio ? "Content Studio" : undefined}
            onOpenStudio={onOpenStudio}
            browserLabel={onOpenBrowser ? "Game in browser" : undefined}
            onOpenBrowser={onOpenBrowser}
            {...handlers}
          />
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name })
}

describe("OpenInSubContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isRemoteDesktopWindow.mockReturnValue(false)
  })

  it("offers Explorer, Terminal and VS Code", () => {
    renderMenu()
    expect(item("Explorer")).toBeTruthy()
    expect(item("Terminal")).toBeTruthy()
    expect(item("VS Code")).toBeTruthy()
  })

  it("runs the VS Code action when the workspace host is this machine", () => {
    renderMenu()
    fireEvent.click(item("VS Code"))
    expect(handlers.onOpenCode).toHaveBeenCalledTimes(1)
  })

  it("disables VS Code in a remote-desktop window", () => {
    // `open_in_code` runs on the host that owns the path, so on a remote
    // workspace the editor would open over there and read as a no-op here.
    mocks.isRemoteDesktopWindow.mockReturnValue(true)
    renderMenu()
    expect(item("VS Code").getAttribute("data-disabled")).not.toBeNull()
    fireEvent.click(item("VS Code"))
    expect(handlers.onOpenCode).not.toHaveBeenCalled()
    // The two rows that stay useful over a remote connection are untouched.
    expect(item("Terminal").getAttribute("data-disabled")).toBeNull()
    fireEvent.click(item("Terminal"))
    expect(handlers.onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it("passes the caller's explorer gate through", () => {
    renderMenu(true)
    expect(item("Explorer").getAttribute("data-disabled")).not.toBeNull()
    fireEvent.click(item("Explorer"))
    expect(handlers.onOpenExplorer).not.toHaveBeenCalled()
  })

  it("adds the Studio row only for a content project", () => {
    renderMenu()
    expect(
      screen.queryByRole("menuitem", { name: "Content Studio" })
    ).toBeNull()
  })

  it("opens Studio from the content-project row", () => {
    const onOpenStudio = vi.fn()
    renderMenu(undefined, onOpenStudio)
    fireEvent.click(item("Content Studio"))
    expect(onOpenStudio).toHaveBeenCalledTimes(1)
  })

  it("opens the game in the browser from a content project", () => {
    const onOpenBrowser = vi.fn()
    renderMenu(undefined, vi.fn(), onOpenBrowser)
    fireEvent.click(item("Game in browser"))
    expect(onOpenBrowser).toHaveBeenCalledTimes(1)
  })

  it("disables the browser row in a remote-desktop window", () => {
    // The preview listener is loopback on the workspace host; this machine's
    // browser can't reach it.
    mocks.isRemoteDesktopWindow.mockReturnValue(true)
    const onOpenBrowser = vi.fn()
    renderMenu(undefined, vi.fn(), onOpenBrowser)
    expect(item("Game in browser").getAttribute("data-disabled")).not.toBeNull()
    expect(item("Content Studio").getAttribute("data-disabled")).toBeNull()
  })
})
