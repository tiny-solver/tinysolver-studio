import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getChatEventFilter: vi.fn(),
  setChatEventFilter: vi.fn(),
  getChatEventWebhooks: vi.fn(),
  setChatEventWebhooks: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { ChannelEventsTab, isValidWebhookUrl } from "./channel-events-tab"
import enMessages from "@/i18n/messages/en.json"
import {
  getChatEventFilter,
  getChatEventWebhooks,
  setChatEventWebhooks,
} from "@/lib/api"
import { toast } from "sonner"
import type { WebhookConfig } from "@/lib/types"

const mockGetFilter = vi.mocked(getChatEventFilter)
const mockGetWebhooks = vi.mocked(getChatEventWebhooks)
const mockSetWebhooks = vi.mocked(setChatEventWebhooks)

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChannelEventsTab />
    </NextIntlClientProvider>
  )
}

function hook(url: string, enabled = true): WebhookConfig {
  return { url, enabled }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFilter.mockResolvedValue(null)
  mockGetWebhooks.mockResolvedValue([])
  mockSetWebhooks.mockResolvedValue(undefined)
})

describe("isValidWebhookUrl", () => {
  it("accepts http(s) and rejects others/empty", () => {
    expect(isValidWebhookUrl("https://a.test/h")).toBe(true)
    expect(isValidWebhookUrl("  http://b.test  ")).toBe(true)
    expect(isValidWebhookUrl("ftp://x.test")).toBe(false)
    expect(isValidWebhookUrl("not a url")).toBe(false)
    expect(isValidWebhookUrl("")).toBe(false)
  })
})

describe("ChannelEventsTab webhooks", () => {
  it("loads existing webhooks and reflects enabled state", async () => {
    mockGetWebhooks.mockResolvedValue([
      hook("https://existing.test/hook", true),
    ])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://existing.test/hook")).toBeInTheDocument()
    )
    expect(
      screen.getByRole("switch", { name: "Enable webhook" })
    ).toBeInTheDocument()
  })

  it("adds a webhook through the dialog and persists it as enabled", async () => {
    renderTab()
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "Add Webhook" }))
    fireEvent.change(
      screen.getByPlaceholderText("https://example.com/webhook"),
      { target: { value: "https://hook.test/in" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://hook.test/in", enabled: true },
      ])
    )
  })

  it("edits a webhook url while preserving its enabled flag", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://old.test/h", false)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://old.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("button", { name: "Edit Webhook" }))
    const input = screen.getByDisplayValue("https://old.test/h")
    fireEvent.change(input, { target: { value: "https://new.test/h" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://new.test/h", enabled: false },
      ])
    )
  })

  it("toggling the switch persists the flipped enabled flag", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("switch", { name: "Enable webhook" }))

    await waitFor(() =>
      expect(mockSetWebhooks).toHaveBeenCalledWith([
        { url: "https://x.test/h", enabled: false },
      ])
    )
  })

  it("deletes a webhook only after confirming in the alert dialog", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    // Opening the confirm dialog must not persist anything on its own.
    fireEvent.click(screen.getByRole("button", { name: "Remove webhook" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
    )
    expect(mockSetWebhooks).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(mockSetWebhooks).toHaveBeenCalledWith([]))
  })

  it("does not delete when the confirm dialog is cancelled", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("button", { name: "Remove webhook" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Delete" })
      ).not.toBeInTheDocument()
    )
    expect(mockSetWebhooks).not.toHaveBeenCalled()
  })

  it("rejects an invalid url in the dialog without persisting", async () => {
    renderTab()
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "Add Webhook" }))
    fireEvent.change(
      screen.getByPlaceholderText("https://example.com/webhook"),
      { target: { value: "not-a-url" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(mockSetWebhooks).not.toHaveBeenCalled()
  })

  it("disables all webhook controls while a save is in flight", async () => {
    mockGetWebhooks.mockResolvedValue([hook("https://x.test/h", true)])
    // A save that we resolve manually, so we can inspect the in-flight state.
    let resolveSave: () => void = () => {}
    mockSetWebhooks.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveSave = () => res()
        })
    )
    renderTab()
    await waitFor(() =>
      expect(screen.getByText("https://x.test/h")).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole("switch", { name: "Enable webhook" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Webhook" })).toBeDisabled()
    )
    expect(screen.getByRole("button", { name: "Edit Webhook" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Remove webhook" })
    ).toBeDisabled()

    resolveSave()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Add Webhook" })
      ).not.toBeDisabled()
    )
  })

  it("does not start a second save when Enter is pressed during a pending dialog save", async () => {
    let resolveSave: () => void = () => {}
    mockSetWebhooks.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveSave = () => res()
        })
    )
    renderTab()
    await waitFor(() => expect(mockGetWebhooks).toHaveBeenCalled())

    fireEvent.click(screen.getByRole("button", { name: "Add Webhook" }))
    const input = screen.getByPlaceholderText("https://example.com/webhook")
    fireEvent.change(input, { target: { value: "https://b.test/h" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSetWebhooks).toHaveBeenCalledTimes(1))

    // The save is still pending: editing + pressing Enter must not fire another.
    fireEvent.change(input, { target: { value: "https://c.test/h" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await Promise.resolve()
    expect(mockSetWebhooks).toHaveBeenCalledTimes(1)

    // Let the in-flight save resolve and the post-save state settle (avoids a
    // React act(...) warning), then confirm still exactly one save fired.
    resolveSave()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(mockSetWebhooks).toHaveBeenCalledTimes(1)
  })
})
