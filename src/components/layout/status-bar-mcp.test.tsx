import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CodegMcpServiceStatus } from "@/lib/api"

const getCodegMcpServiceStatus = vi.fn<() => Promise<CodegMcpServiceStatus>>()
const startCodegMcpService = vi.fn<() => Promise<void>>()
const openSettingsWindow = vi.fn()

vi.mock("@/lib/api", () => ({
  getCodegMcpServiceStatus: () => getCodegMcpServiceStatus(),
  startCodegMcpService: () => startCodegMcpService(),
  openSettingsWindow: (...args: unknown[]) => openSettingsWindow(...args),
}))

import { StatusBarMcp } from "./status-bar-mcp"
import enMessages from "@/i18n/messages/en.json"

function makeStatus(
  overrides: Partial<CodegMcpServiceStatus> = {}
): CodegMcpServiceStatus {
  return {
    state: "running",
    listening: true,
    socket_path: "/tmp/codeg-delegation-4242.sock",
    binary_path: "/Applications/codeg.app/Contents/MacOS/codeg-mcp",
    tool_groups: [
      { key: "delegation", enabled: true },
      { key: "feedback", enabled: true },
      { key: "ask", enabled: false },
      { key: "sessions", enabled: false },
      { key: "automations", enabled: false },
      { key: "taskboard", enabled: false },
    ],
    companion_count: 2,
    session_count: 2,
    active_delegations: 1,
    depth_limit: 3,
    started_at: null,
    last_error: null,
    can_start: true,
    ...overrides,
  }
}

async function mount() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarMcp />
    </NextIntlClientProvider>
  )
  // Wait for the mount fetch to land before anyone reads the trigger.
  await waitFor(() => expect(getCodegMcpServiceStatus).toHaveBeenCalled())
}

/** Open the popover. The trigger is the only button until it opens. */
async function openPopover() {
  fireEvent.click(screen.getAllByRole("button")[0])
  await screen.findByText("Broker socket")
}

beforeEach(() => {
  getCodegMcpServiceStatus.mockReset()
  startCodegMcpService.mockReset()
  openSettingsWindow.mockReset()
  getCodegMcpServiceStatus.mockResolvedValue(makeStatus())
  startCodegMcpService.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("StatusBarMcp", () => {
  it("shows the live session count on the trigger while running", async () => {
    await mount()
    expect(await screen.findByTitle(/Running/)).toHaveTextContent("2")
  })

  it("reports the socket, the resolved binary and only the enabled groups", async () => {
    await mount()
    await openPopover()

    expect(screen.getByText("Listening")).toBeInTheDocument()
    expect(
      screen.getByText("/tmp/codeg-delegation-4242.sock")
    ).toBeInTheDocument()
    expect(
      screen.getByText("/Applications/codeg.app/Contents/MacOS/codeg-mcp")
    ).toBeInTheDocument()
    expect(screen.getByText("Delegation")).toBeInTheDocument()
    expect(screen.getByText("Live feedback")).toBeInTheDocument()
    // Disabled groups are absent, not greyed — the list answers "what does an
    // agent get", so a switched-off group has nothing to say here.
    expect(screen.queryByText("Ask a question")).not.toBeInTheDocument()
  })

  /** The headline promise of the feature: a dead socket is repairable in place. */
  it("offers the start button when stopped and refetches after starting", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false, session_count: 0 })
    )
    await mount()
    await openPopover()

    const start = screen.getByRole("button", { name: /Start service/ })
    getCodegMcpServiceStatus.mockResolvedValue(makeStatus())
    fireEvent.click(start)

    await waitFor(() => expect(startCodegMcpService).toHaveBeenCalledTimes(1))
    // Status is re-read after the start so the popover reflects the new truth
    // rather than the one that motivated the click.
    await waitFor(() =>
      expect(getCodegMcpServiceStatus.mock.calls.length).toBeGreaterThan(1)
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Start service/ })
      ).not.toBeInTheDocument()
    )
  })

  /** A start we know would fail must not be offered — `can_start` is false in
   * runtimes that never bound a socket. */
  it("hides the start button when the process holds no service handle", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false, can_start: false })
    )
    await mount()
    await openPopover()

    expect(
      screen.queryByRole("button", { name: /Start service/ })
    ).not.toBeInTheDocument()
  })

  /** Every other state is a healthy socket, so nothing here can start it. */
  it("does not offer a start button for a missing companion binary", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "unavailable", binary_path: null })
    )
    await mount()
    await openPopover()

    expect(screen.getByText("Not found")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Start service/ })
    ).not.toBeInTheDocument()
  })

  it("surfaces a failed start without claiming the service is broken", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false })
    )
    startCodegMcpService.mockRejectedValue(new Error("address already in use"))
    await mount()
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: /Start service/ }))
    expect(
      await screen.findByText(/Could not start: address already in use/)
    ).toBeInTheDocument()
  })

  /** A failed status call says nothing about the service, so it must not be
   * painted as a service fault. */
  it("falls back to an unknown state when the status call fails", async () => {
    getCodegMcpServiceStatus.mockRejectedValue(new Error("transport offline"))
    await mount()
    await openPopover2()

    expect(
      screen.getByText(/Could not read the status: transport offline/)
    ).toBeInTheDocument()
    expect(screen.queryByText("Broker socket")).not.toBeInTheDocument()
  })
})

/** Variant of {@link openPopover} for the error path, where the detail block
 * (and its "Broker socket" row) is never rendered. */
async function openPopover2() {
  fireEvent.click(screen.getAllByRole("button")[0])
  await screen.findByRole("button", { name: /Settings/ })
}
