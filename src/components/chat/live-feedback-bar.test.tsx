import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { EventEnvelope, FeedbackItem } from "@/lib/types"

// Capture the handler `useAcpEvent` registers so tests can fire events.
let capturedHandler: ((env: EventEnvelope) => void) | null = null
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (env: EventEnvelope) => void) => {
    capturedHandler = handler
  },
}))

vi.mock("@/lib/api", () => ({
  submitSessionFeedback: vi.fn(),
  acpGetSessionSnapshot: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { LiveFeedbackBar } from "./live-feedback-bar"
import enMessages from "@/i18n/messages/en.json"
import { acpGetSessionSnapshot, submitSessionFeedback } from "@/lib/api"
import type { ConnectionStatus, LiveSessionSnapshot } from "@/lib/types"

const mockSubmit = vi.mocked(submitSessionFeedback)
const mockSnapshot = vi.mocked(acpGetSessionSnapshot)

function note(id: string, text: string, status: "pending" | "delivered") {
  return {
    id,
    text,
    created_at: "2026-06-07T00:00:00Z",
    status,
  } as FeedbackItem
}

/** A snapshot with the feedback tool available by default (the gate the bar
 *  now reads); override `feedback` / `feedback_tool_available` per test. */
function snapshot(
  overrides: Partial<LiveSessionSnapshot> = {}
): LiveSessionSnapshot {
  return {
    feedback_tool_available: true,
    feedback: [],
    ...overrides,
  } as unknown as LiveSessionSnapshot
}

function renderBar(
  props: Partial<{
    connectionId: string | null
    connStatus: ConnectionStatus | null
    enabled: boolean
    onResendAsPrompt: (text: string) => void
  }> = {}
) {
  const merged = {
    connectionId: "c1",
    connStatus: "prompting" as ConnectionStatus | null,
    enabled: true,
    ...props,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LiveFeedbackBar {...merged} />
    </NextIntlClientProvider>
  )
}

function fire(env: Partial<EventEnvelope> & { type: string }) {
  act(() => {
    capturedHandler?.({ connection_id: "c1", seq: 1, ...env } as EventEnvelope)
  })
}

beforeEach(() => {
  mockSubmit.mockReset()
  mockSnapshot.mockReset()
  // Default: the tool is available, no notes to hydrate (tests opt into notes).
  mockSnapshot.mockResolvedValue(snapshot())
  capturedHandler = null
})

describe("LiveFeedbackBar", () => {
  it("renders nothing when the feature is disabled", () => {
    const { container } = renderBar({ enabled: false })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the agent lacks the feedback tool (pre-enable session)", async () => {
    // Global setting on, but this connection's snapshot says no tool.
    mockSnapshot.mockResolvedValue(snapshot({ feedback_tool_available: false }))
    const { container } = renderBar() // prompting + enabled
    // Give the snapshot fetch a tick to resolve; the bar must stay hidden.
    await act(async () => {
      await Promise.resolve()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when idle with no unread notes", () => {
    const { container } = renderBar({ connStatus: "connected" })
    expect(container).toBeEmptyDOMElement()
  })

  it("submits a note and shows it as a waiting chip, then flips to received", async () => {
    mockSubmit.mockResolvedValue(note("f1", "use UserService", "pending"))
    renderBar()

    const input = await screen.findByLabelText("Live feedback note")
    fireEvent.change(input, { target: { value: "use UserService" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith("c1", "use UserService")
    })
    // Optimistic chip with the "waiting" status.
    expect(await screen.findByText("use UserService")).toBeInTheDocument()
    expect(screen.getByText("waiting")).toBeInTheDocument()

    // The agent reads it → consumed event flips the chip to "received".
    fire({ type: "feedback_consumed", ids: ["f1"], delivered_at: "x" })
    await waitFor(() => {
      expect(screen.getByText("received")).toBeInTheDocument()
    })
    expect(screen.queryByText("waiting")).not.toBeInTheDocument()
  })

  it("dedups a submitted note against its broadcast event (by id)", async () => {
    mockSubmit.mockResolvedValue(note("f1", "only once", "pending"))
    renderBar()

    fireEvent.change(await screen.findByLabelText("Live feedback note"), {
      target: { value: "only once" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled())

    // The broadcast echo for the same id must not add a second chip.
    fire({
      type: "feedback_submitted",
      item: note("f1", "only once", "pending"),
    })
    expect(screen.getAllByText("only once")).toHaveLength(1)
  })

  it("resends as a prompt when the turn ended mid-submit (NoActiveTurn)", async () => {
    // The backend rejects the submit because the turn just ended (the frontend
    // may still read connStatus === "prompting" in this race). The bar must
    // route the note to the resend path, not silently drop it.
    const onResendAsPrompt = vi.fn()
    mockSubmit.mockRejectedValue("no active turn to send feedback to")
    renderBar({ onResendAsPrompt }) // connStatus = "prompting"

    fireEvent.change(await screen.findByLabelText("Live feedback note"), {
      target: { value: "late note" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => {
      expect(onResendAsPrompt).toHaveBeenCalledWith("late note")
    })
    // The submit failed, so no optimistic chip leaks for the dropped note.
    expect(screen.queryByText("late note")).not.toBeInTheDocument()
  })

  it("offers to resend an unread note as a prompt after the turn ends", async () => {
    const onResendAsPrompt = vi.fn()
    mockSubmit.mockResolvedValue(note("f1", "steer me", "pending"))
    const { rerender } = renderBar({ onResendAsPrompt })

    fireEvent.change(await screen.findByLabelText("Live feedback note"), {
      target: { value: "steer me" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled())

    // Turn ends with the note still pending → fallback prompt appears.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LiveFeedbackBar
          connectionId="c1"
          connStatus="connected"
          enabled
          onResendAsPrompt={onResendAsPrompt}
        />
      </NextIntlClientProvider>
    )
    const resendBtn = await screen.findByRole("button", {
      name: "Send as message",
    })
    fireEvent.click(resendBtn)
    expect(onResendAsPrompt).toHaveBeenCalledWith("steer me")
  })

  it("hydrates pending notes from the snapshot on mount (refresh/attach)", async () => {
    // A mid-turn attach: the snapshot carries a pending note the live event
    // stream won't replay. The bar must show it.
    mockSnapshot.mockResolvedValue(
      snapshot({ feedback: [note("f9", "hydrated note", "pending")] })
    )
    renderBar()
    expect(await screen.findByText("hydrated note")).toBeInTheDocument()
    expect(mockSnapshot).toHaveBeenCalledWith("c1")
  })

  it("applies a consumed event that lands before snapshot hydration (no stale pending)", async () => {
    // Defer the snapshot so the consume event can race ahead of hydration.
    let resolveSnap: (s: LiveSessionSnapshot | null) => void = () => {}
    mockSnapshot.mockReturnValue(
      new Promise<LiveSessionSnapshot | null>((r) => {
        resolveSnap = r
      })
    )
    renderBar() // hydration in-flight

    // The agent reads the note (consume event) BEFORE the snapshot resolves.
    fire({
      type: "feedback_consumed",
      ids: ["f9"],
      delivered_at: "2026-06-07T00:00:00Z",
    })

    // The (now-stale) snapshot resolves still showing f9 as pending.
    await act(async () => {
      resolveSnap(
        snapshot({ feedback: [note("f9", "already read", "pending")] })
      )
      await Promise.resolve()
    })

    // The tombstone must win: rendered as received, never a false "waiting" /
    // "Send as message".
    expect(await screen.findByText("already read")).toBeInTheDocument()
    expect(screen.getByText("received")).toBeInTheDocument()
    expect(screen.queryByText("waiting")).not.toBeInTheDocument()
  })

  it("applies a consumed event that arrives before its submitted event (out-of-order)", async () => {
    renderBar() // tool available, no notes
    // Broadcast race: the consume lands before the matching submit.
    fire({
      type: "feedback_consumed",
      ids: ["f7"],
      delivered_at: "2026-06-07T00:00:00Z",
    })
    fire({
      type: "feedback_submitted",
      item: note("f7", "out of order", "pending"),
    })
    // The tombstone must win: rendered as received, never a false "waiting".
    expect(await screen.findByText("out of order")).toBeInTheDocument()
    expect(screen.getByText("received")).toBeInTheDocument()
    expect(screen.queryByText("waiting")).not.toBeInTheDocument()
  })

  it("resets and re-hydrates when connectionId changes (no stale chips)", async () => {
    mockSubmit.mockResolvedValue(note("f1", "old conn note", "pending"))
    const { rerender } = renderBar()
    fireEvent.change(await screen.findByLabelText("Live feedback note"), {
      target: { value: "old conn note" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByText("old conn note")).toBeInTheDocument()

    // Reconnect → new connectionId. The stale chip must clear; the new
    // connection's snapshot hydrates fresh.
    mockSnapshot.mockResolvedValue(
      snapshot({ feedback: [note("g1", "new conn note", "pending")] })
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LiveFeedbackBar connectionId="c2" connStatus="prompting" enabled />
      </NextIntlClientProvider>
    )
    await waitFor(() => {
      expect(screen.queryByText("old conn note")).not.toBeInTheDocument()
    })
    expect(await screen.findByText("new conn note")).toBeInTheDocument()
  })

  it("clears notes when a new turn starts (user_message)", async () => {
    mockSubmit.mockResolvedValue(note("f1", "old note", "pending"))
    renderBar()
    fireEvent.change(await screen.findByLabelText("Live feedback note"), {
      target: { value: "old note" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByText("old note")).toBeInTheDocument()

    fire({ type: "user_message", message_id: "u2", blocks: [] })
    await waitFor(() => {
      expect(screen.queryByText("old note")).not.toBeInTheDocument()
    })
  })
})
