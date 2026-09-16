import { describe, expect, it } from "vitest"

import { normalizeTypedAddress } from "./browser-toolbar"

describe("normalizeTypedAddress", () => {
  it("keeps full http(s) URLs and normalizes them", () => {
    expect(normalizeTypedAddress("  https://Example.com/a b ")).toBe(
      "https://example.com/a%20b"
    )
    expect(normalizeTypedAddress("http://localhost:3000")).toBe(
      "http://localhost:3000/"
    )
  })

  it("adds a scheme to bare hosts: http for local, https otherwise", () => {
    expect(normalizeTypedAddress("localhost:3000/app")).toBe(
      "http://localhost:3000/app"
    )
    expect(normalizeTypedAddress("127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/"
    )
    expect(normalizeTypedAddress("192.168.1.5")).toBe("http://192.168.1.5/")
    expect(normalizeTypedAddress("example.com/docs?x=1")).toBe(
      "https://example.com/docs?x=1"
    )
  })

  it("refuses other schemes, words and blanks (no search fallback)", () => {
    expect(normalizeTypedAddress("javascript:alert(1)")).toBeNull()
    expect(normalizeTypedAddress("file:///etc/hosts")).toBeNull()
    expect(normalizeTypedAddress("hello world")).toBeNull()
    expect(normalizeTypedAddress("notes")).toBeNull()
    expect(normalizeTypedAddress("")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The profile chip and its menu
// ---------------------------------------------------------------------------

import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import {
  resetBrowserPrefsForTests,
  setBrowserProfiles,
} from "@/lib/browser/browser-prefs"

import { openUrl } from "@/lib/platform"

import { BrowserToolbar } from "./browser-toolbar"

const toolbarMocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn(() => "browser:new"),
  workspaceActions: null as null | {
    openBrowserTab: (...a: unknown[]) => unknown
  },
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => toolbarMocks.workspaceActions,
}))
vi.mock("@/lib/browser/browser-api", () => ({
  // The toolbar also carries the agent share control.
  browserAgentGrant: vi.fn(() => Promise.resolve()),
  browserGoBack: vi.fn(),
  browserGoForward: vi.fn(),
  browserNavigate: vi.fn(),
  browserReload: vi.fn(),
  browserStop: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))

function tabIn(
  profile: string,
  initialUrl = "https://example.com/"
): BrowserWorkspaceTab {
  return {
    id: "browser:abc",
    kind: "browser",
    folderId: 1,
    title: "example.com",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: { initialUrl, openerTabId: null, profile },
  } as BrowserWorkspaceTab
}

function renderToolbar(profile: string, initialUrl?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserToolbar tab={tabIn(profile, initialUrl)} state={null} />
    </NextIntlClientProvider>
  )
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event, so a real
// `MouseEvent` under the pointer-event name is what opens the menu.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

async function openMenu(trigger: Element) {
  await act(async () => {
    fireMouse(trigger, "pointerdown")
    fireMouse(trigger, "pointerup")
    fireMouse(trigger, "click")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("BrowserToolbar profile chip", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    toolbarMocks.openBrowserTab.mockClear()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
  })

  it("stays out of the way while only the default profile exists", () => {
    renderToolbar("default")
    expect(screen.queryByRole("button", { name: /^Profile:/ })).toBeNull()
  })

  it("names the tab's profile and opens the page in another one from the menu", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    renderToolbar("p-work")
    const chip = screen.getByRole("button", { name: "Profile: Work" })
    expect(chip).toHaveTextContent("Work")

    await openMenu(chip)
    expect(screen.getByText("Open this page in another profile")).toBeVisible()
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual(["Default", "Work"])
    expect(items[1]).toHaveAttribute("aria-checked", "true")

    await act(async () => {
      fireEvent.click(items[0])
    })
    expect(toolbarMocks.openBrowserTab).toHaveBeenCalledWith(
      "https://example.com/",
      { profile: "default", openerTabId: "browser:abc" }
    )
  })

  it("leaves an empty tab's address bar blank, focused, and its address actions off", () => {
    renderToolbar("default", "about:blank")
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    // `about:blank` is the absence of a page, not an address anyone typed —
    // showing it would mean selecting-and-overtyping it on every visit.
    expect(bar).toHaveValue("")
    expect(bar).toHaveFocus()
    // Every item behind "More" acts on the address, and there is none.
    expect(screen.getByRole("button", { name: "More" })).toBeDisabled()
  })

  it("leaves a real address in the bar and does not steal focus", () => {
    renderToolbar("default")
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    expect(bar).toHaveValue("https://example.com/")
    expect(bar).not.toHaveFocus()
    expect(screen.getByRole("button", { name: "More" })).toBeEnabled()
  })

  it("keeps copy and open-in-system behind the More menu, not on the row", async () => {
    renderToolbar("default")
    // The row itself is down to the controls used while browsing; these two
    // act on the address and cost a click.
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Open in system browser" })
    ).toBeNull()

    await openMenu(screen.getByRole("button", { name: "More" }))
    expect(
      await screen.findByRole("menuitem", { name: "Copy link" })
    ).toBeVisible()
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Open in system browser" })
      )
    })
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith("https://example.com/")
  })

  it("shows the chip for a tab whose profile is gone, and cannot open elsewhere without a workspace", async () => {
    toolbarMocks.workspaceActions = null
    renderToolbar("p-gone")
    const chip = screen.getByRole("button", { name: "Profile: p-gone" })
    await openMenu(chip)
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual(["Default", "p-gone"])
    // Nothing to open a tab with: the other profiles are inert.
    expect(items[0]).toHaveAttribute("aria-disabled", "true")
    await act(async () => {
      fireEvent.click(items[0])
    })
    expect(toolbarMocks.openBrowserTab).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Selecting the address
// ---------------------------------------------------------------------------

describe("BrowserToolbar address selection", () => {
  const ADDRESS = "https://example.com/"

  beforeEach(() => {
    resetBrowserPrefsForTests()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
  })

  function addressBar(): HTMLInputElement {
    return screen.getByRole("textbox", {
      name: "Enter an address",
    }) as HTMLInputElement
  }

  function selection(input: HTMLInputElement) {
    return [input.selectionStart, input.selectionEnd]
  }

  it("selects the whole address whenever the bar takes focus", () => {
    renderToolbar("default")
    const bar = addressBar()
    act(() => bar.focus())
    expect(selection(bar)).toEqual([0, ADDRESS.length])
  })

  it("keeps the address selected through the click that focused it", () => {
    renderToolbar("default")
    const bar = addressBar()
    fireEvent.mouseDown(bar, { clientX: 120, clientY: 20 })
    act(() => bar.focus())
    // jsdom runs no selection default of its own. Stand in for the engine's:
    // it collapses to where the pointer landed, and it runs on the release
    // AFTER this handler, so cancelling the release is the only thing that
    // stops it — hence the `false` below.
    bar.setSelectionRange(8, 8)
    const delivered = fireEvent.mouseUp(bar, { clientX: 121, clientY: 20 })
    expect(delivered).toBe(false)
    expect(selection(bar)).toEqual([0, ADDRESS.length])
  })

  it("keeps its hands off a non-primary press", () => {
    renderToolbar("default")
    const bar = addressBar()
    // A right press is not a click. Cancelling its release would take the
    // context menu with it wherever one is raised from the release (and the
    // X11 middle-click paste, for button 1).
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20, button: 2 })
    act(() => bar.focus())
    bar.setSelectionRange(8, 8)
    expect(
      fireEvent.mouseUp(bar, { clientX: 60, clientY: 20, button: 2 })
    ).toBe(true)
    expect(selection(bar)).toEqual([8, 8])
  })

  it("does not let a press outlive its own gesture", () => {
    renderToolbar("default")
    const bar = addressBar()
    // Press inside, drag out, release outside: the input never sees a
    // mouseup, so the armed press has to be cleared by the NEXT press rather
    // than survive to cancel someone else's release.
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    act(() => bar.focus())
    bar.setSelectionRange(2, 9)
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20, button: 2 })
    expect(
      fireEvent.mouseUp(bar, { clientX: 60, clientY: 20, button: 2 })
    ).toBe(true)
    expect(selection(bar)).toEqual([2, 9])
  })

  it("leaves a dragged-out range, and a caret click once it has focus, alone", () => {
    renderToolbar("default")
    const bar = addressBar()
    // Dragging picks a range deliberately — that is the user's answer, and
    // the engine's own selection has to reach it.
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    act(() => bar.focus())
    bar.setSelectionRange(8, 19)
    expect(fireEvent.mouseUp(bar, { clientX: 140, clientY: 20 })).toBe(true)
    expect(selection(bar)).toEqual([8, 19])

    // And a click inside a bar that already has focus means "edit here".
    bar.setSelectionRange(8, 8)
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    expect(fireEvent.mouseUp(bar, { clientX: 60, clientY: 20 })).toBe(true)
    expect(selection(bar)).toEqual([8, 8])
  })
})
