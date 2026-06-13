import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getLogSettings: vi.fn(),
  getRecentLogs: vi.fn(),
  listLogFiles: vi.fn(),
  openLogsDir: vi.fn(),
  readLogFile: vi.fn(),
  setLogSettings: vi.fn(),
  subscribeLogAppended: vi.fn(),
  subscribeLogSettingsChanged: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: vi.fn(() => true),
  openPath: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/app-error", () => ({
  toErrorMessage: (e: unknown) => String(e),
}))

import { LogsSettings } from "./logs-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getLogSettings,
  getRecentLogs,
  subscribeLogAppended,
  subscribeLogSettingsChanged,
} from "@/lib/api"
import type { LogRecord } from "@/lib/types"

const mockGetSettings = vi.mocked(getLogSettings)
const mockGetRecent = vi.mocked(getRecentLogs)
const mockSubAppended = vi.mocked(subscribeLogAppended)
const mockSubSettings = vi.mocked(subscribeLogSettingsChanged)

const M = enMessages.LogsSettings

function rec(
  seq: number,
  level: string,
  target: string,
  message: string
): LogRecord {
  return { seq, timestamp_ms: 1_700_000_000_000 + seq, level, target, message }
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LogsSettings />
    </NextIntlClientProvider>
  )
}

let appendedHandler: ((r: LogRecord) => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  appendedHandler = undefined
  mockGetSettings.mockResolvedValue({ level: "info", env_locked: false })
  mockGetRecent.mockResolvedValue([])
  mockSubSettings.mockResolvedValue(() => {})
  mockSubAppended.mockImplementation(async (handler) => {
    appendedHandler = handler
    return () => {}
  })
})

describe("LogsSettings", () => {
  it("renders recent log records", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "ERROR", "acp", "boom happened"),
      rec(2, "INFO", "web", "server started"),
    ])
    renderWithIntl()
    expect(await screen.findByText("boom happened")).toBeInTheDocument()
    expect(screen.getByText("server started")).toBeInTheDocument()
  })

  it("filters displayed records by search text", async () => {
    mockGetRecent.mockResolvedValue([
      rec(1, "ERROR", "acp", "boom happened"),
      rec(2, "INFO", "web", "server started"),
    ])
    renderWithIntl()
    await screen.findByText("boom happened")

    fireEvent.change(screen.getByPlaceholderText(M.searchPlaceholder), {
      target: { value: "boom" },
    })

    expect(screen.getByText("boom happened")).toBeInTheDocument()
    expect(screen.queryByText("server started")).not.toBeInTheDocument()
  })

  it("appends live-tailed records", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "first record")])
    renderWithIntl()
    await screen.findByText("first record")
    await waitFor(() => expect(appendedHandler).toBeDefined())

    await act(async () => {
      appendedHandler?.(rec(2, "WARN", "acp", "live arrived"))
    })

    expect(await screen.findByText("live arrived")).toBeInTheDocument()
  })

  it("clears the view", async () => {
    mockGetRecent.mockResolvedValue([rec(1, "INFO", "web", "to be cleared")])
    renderWithIntl()
    await screen.findByText("to be cleared")

    fireEvent.click(screen.getByRole("button", { name: M.clear }))

    expect(screen.queryByText("to be cleared")).not.toBeInTheDocument()
    expect(screen.getByText(M.empty)).toBeInTheDocument()
  })
})
