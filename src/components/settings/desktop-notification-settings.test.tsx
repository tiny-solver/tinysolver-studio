import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

interface FakeIdentity {
  bundleId: string
  requestedBundleId: string
  degraded: boolean
}

const permission = vi.fn<() => string>(() => "granted")
const requestPermission = vi.fn(async () => "granted")
const openSystemSettings = vi.fn(async () => undefined)
const sendTest = vi.fn(async () => undefined)
const identity = vi.fn<() => Promise<FakeIdentity | null>>(async () => null)

vi.mock("@/lib/notification", () => ({
  getNotificationPermission: () => permission(),
  requestNotificationPermission: () => requestPermission(),
  openSystemNotificationSettings: () => openSystemSettings(),
  getNotificationIdentity: () => identity(),
}))
vi.mock("@/lib/desktop-notification", () => ({
  sendTestNotification: (...args: unknown[]) => sendTest(...(args as [])),
}))

import { DesktopNotificationSettingsSection } from "./desktop-notification-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFS,
  loadDesktopNotificationPrefs,
  resetDesktopNotificationPrefsCacheForTests,
  type DesktopNotificationPrefs,
} from "@/lib/desktop-notification-prefs"

const STORAGE_KEY = "settings:desktop-notification:v1"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DesktopNotificationSettingsSection />
    </NextIntlClientProvider>
  )
}

/** Write the key the way another window would, then announce it. */
function writeFromAnotherWindow(prefs: DesktopNotificationPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))
  })
}

beforeEach(() => {
  localStorage.clear()
  resetDesktopNotificationPrefsCacheForTests()
  permission.mockReturnValue("granted")
  requestPermission.mockClear().mockResolvedValue("granted")
  openSystemSettings.mockClear()
  sendTest.mockClear().mockResolvedValue(undefined)
  identity.mockClear().mockResolvedValue(null)
})

describe("DesktopNotificationSettingsSection", () => {
  it("starts enabled, matching the behaviour that already shipped", () => {
    renderSection()

    expect(
      screen.getByRole("switch", { name: /desktop notifications/i })
    ).toBeChecked()
    for (const label of [
      "Turn Complete",
      "Permission Request",
      "Agent Question",
      "Agent Error",
      "Background task",
      "Work task",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it("collapses to the master switch when turned off", () => {
    renderSection()

    fireEvent.click(
      screen.getByRole("switch", { name: /desktop notifications/i })
    )

    expect(loadDesktopNotificationPrefs().enabled).toBe(false)
    // The section IS the master switch once off: no event rows, no gates.
    expect(screen.getAllByRole("switch")).toHaveLength(1)
    expect(screen.queryByText("Turn Complete")).not.toBeInTheDocument()
  })

  it("persists a per-event switch without touching the others", () => {
    renderSection()

    fireEvent.click(screen.getByRole("switch", { name: "Agent Error" }))

    const stored = loadDesktopNotificationPrefs()
    expect(stored.events.error).toBe(false)
    expect(stored.events.turn_complete).toBe(true)
  })

  it("persists the delivery gate", async () => {
    renderSection()

    // The trigger reflects the default before anything is touched.
    expect(
      screen.getByRole("combobox", { name: /notify when/i })
    ).toHaveTextContent("Window is not visible")

    writeFromAnotherWindow({
      ...DEFAULT_DESKTOP_NOTIFICATION_PREFS,
      when: "unfocused",
    })

    expect(
      screen.getByRole("combobox", { name: /notify when/i })
    ).toHaveTextContent("Window is not focused")
  })

  it("follows a change made in another window", () => {
    renderSection()
    expect(
      screen.getByRole("switch", { name: /desktop notifications/i })
    ).toBeChecked()

    writeFromAnotherWindow({
      ...DEFAULT_DESKTOP_NOTIFICATION_PREFS,
      enabled: false,
    })

    expect(
      screen.getByRole("switch", { name: /desktop notifications/i })
    ).not.toBeChecked()
  })
})

describe("the permission card", () => {
  it("offers the system-settings shortcut on desktop, not a request button", () => {
    // Desktop has no permission to request — the OS owns it, and a "Allow
    // notifications" button there would do nothing at all.
    permission.mockReturnValue("managed_by_os")
    renderSection()

    expect(screen.getByText("Managed by the system")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /allow notifications/i })
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: /open system settings/i })
    )
    expect(openSystemSettings).toHaveBeenCalled()
  })

  it("offers the request button only while the browser is undecided", async () => {
    permission.mockReturnValue("default")
    renderSection()

    expect(screen.getByText("Not requested")).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: /allow notifications/i })
    )

    await waitFor(() => expect(requestPermission).toHaveBeenCalled())
    // The answer replaces the badge, and the now-useless button goes away.
    expect(await screen.findByText("Allowed")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /allow notifications/i })
    ).not.toBeInTheDocument()
  })

  it("does not offer to re-ask a browser that already said no", () => {
    // Once denied, only the browser's own site settings can undo it; a page
    // cannot raise the prompt again.
    permission.mockReturnValue("denied")
    renderSection()

    expect(screen.getByText("Blocked")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /allow notifications/i })
    ).not.toBeInTheDocument()
  })

  it("hides the test button where notifications cannot exist at all", () => {
    // A `codeg-server` over plain http:// on a LAN address — no secure
    // context, so there is nothing to test.
    permission.mockReturnValue("unsupported")
    renderSection()

    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /send a test/i })
    ).not.toBeInTheDocument()
  })

  it("sends a test notification", async () => {
    renderSection()

    fireEvent.click(screen.getByRole("button", { name: /send a test/i }))

    await waitFor(() =>
      expect(sendTest).toHaveBeenCalledWith(
        "Codeg",
        "Desktop notifications are working."
      )
    )
  })
})

describe("the delivering identity", () => {
  it("names the app the OS files the notifications under", async () => {
    permission.mockReturnValue("managed_by_os")
    identity.mockResolvedValue({
      bundleId: "app.codeg",
      requestedBundleId: "app.codeg",
      degraded: false,
    })
    renderSection()

    expect(await screen.findByText("app.codeg")).toBeInTheDocument()
    expect(screen.getByText("Delivered as")).toBeInTheDocument()
  })

  it("warns when delivery has fallen back to another app", async () => {
    // The failure this row exists for: a build that could not claim its own
    // identifier posts as Terminal, so every switch the user can see under
    // "codeg" in System Settings governs nothing at all.
    permission.mockReturnValue("managed_by_os")
    identity.mockResolvedValue({
      bundleId: "com.apple.Terminal",
      requestedBundleId: "app.codeg",
      degraded: true,
    })
    renderSection()

    expect(await screen.findByText("com.apple.Terminal")).toBeInTheDocument()
    expect(screen.getByText(/could not be claimed/i)).toBeInTheDocument()
  })

  it("stays hidden when the backend cannot answer", async () => {
    permission.mockReturnValue("managed_by_os")
    identity.mockRejectedValue(new Error("no such command"))
    renderSection()

    // "We don't know" renders as nothing, not as a guess.
    await waitFor(() => expect(identity).toHaveBeenCalled())
    expect(screen.queryByText("Delivered as")).not.toBeInTheDocument()
  })

  it("claims no identity for a section the user turned off", () => {
    // Reading the identity is what claims it on the backend, so a collapsed
    // section must not reach for it.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFS, enabled: false })
    )
    resetDesktopNotificationPrefsCacheForTests()
    permission.mockReturnValue("managed_by_os")
    renderSection()

    expect(identity).not.toHaveBeenCalled()
  })
})
