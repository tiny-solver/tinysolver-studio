import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { DelegatedSubThread } from "./delegated-sub-thread"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

// MessageResponse pulls in workspace context + active folder hooks that
// aren't available in this test's shallow render. We only care that the
// component shows markdown text — render an h1 for fenced headers + the
// raw rest, no streaming, no link-safety. Anything richer is covered by
// MessageResponse's own tests.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => {
    const text = typeof children === "string" ? children : String(children)
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    return (
      <div data-testid="markdown-stub">
        {lines.map((line, i) => {
          const heading = line.match(/^(#+)\s+(.*)$/)
          if (heading) {
            const level = heading[1].length
            const body = heading[2]
            if (level === 1) return <h1 key={i}>{body}</h1>
            if (level === 2) return <h2 key={i}>{body}</h2>
            return <h3 key={i}>{body}</h3>
          }
          return <p key={i}>{line}</p>
        })}
      </div>
    )
  },
}))

const { useDelegatedSubSession } =
  await import("@/hooks/use-delegated-sub-session")
const mockedHook = vi.mocked(useDelegatedSubSession)

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function bindingOf(overrides: Partial<DelegationBinding>): DelegationBinding {
  return {
    parentConnectionId: "p1",
    parentToolUseId: "pt-1",
    childConnectionId: "c1",
    childConversationId: 99,
    agentType: "codex",
    status: "running",
    ...overrides,
  }
}

describe("DelegatedSubThread", () => {
  it("renders nothing when there's no binding and no parseable input", () => {
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
    const { container } = renderWithIntl(
      <DelegatedSubThread parentToolUseId="pt-1" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders agent label + running badge when delegation is in-flight", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    // AgentIcon's <title>Codex</title> + the visible label both produce
    // "Codex" matches; assert there are *some* matches and the name is
    // present in the visible card header.
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
    expect(screen.getByText("running")).toBeInTheDocument()
    // collapsed by default — sub-thread body not present
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
  })

  it("renders the task line directly from input even without a binding", () => {
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
    const input = JSON.stringify({
      agent_type: "codex",
      task: "summarize the failing tests",
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" input={input} />)
    expect(screen.getByText("summarize the failing tests")).toBeInTheDocument()
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0)
  })

  it("shows the error badge with the localized code", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "err", errorCode: "timeout" }),
      detail: null,
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    expect(screen.getByText("timeout")).toBeInTheDocument()
  })

  it("collapsed card does NOT render the outcome — only the toggle reveals it", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "ok" }),
      detail: null,
      loading: false,
      error: null,
    })
    const output = JSON.stringify({
      kind: "ok",
      text: "# Result\n\nAll good.",
      child_conversation_id: 99,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        output={output}
        state="output-available"
      />
    )
    expect(screen.queryByText(/All good\./)).not.toBeInTheDocument()
    // Markdown header sticks an <h1> inside the body — find via heading role.
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText(/All good\./)).toBeInTheDocument()
    // Heading was extracted, not rendered as literal "# Result".
    expect(screen.queryByText(/^# Result/)).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Result"
    )
  })

  it("when the delegation binding never arrives but the tool output did, the expanded body shows the outcome — not 'waiting for child'", () => {
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
    const inputJson = JSON.stringify({
      agent_type: "codex",
      task: "test the build",
    })
    const outputJson = JSON.stringify({
      kind: "ok",
      text: "Build succeeded.",
      child_conversation_id: 99,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={inputJson}
        output={outputJson}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Build succeeded.")).toBeInTheDocument()
    expect(
      screen.queryByText(/Waiting for the child agent to start/)
    ).not.toBeInTheDocument()
  })

  it("does NOT show the 'waiting for child' line once the tool reached output-available, even if output is an empty string", () => {
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
    const inputJson = JSON.stringify({
      agent_type: "codex",
      task: "noop",
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={inputJson}
        output={""}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(
      screen.queryByText(/Waiting for the child agent to start/)
    ).not.toBeInTheDocument()
    // Falls back to the "no detail" copy instead of a misleading spinner.
    expect(screen.getByText(/No detail available yet/)).toBeInTheDocument()
  })

  it("renders an error outcome from the broker as a destructive block", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "err", errorCode: "timeout" }),
      detail: null,
      loading: false,
      error: null,
    })
    const output = JSON.stringify({
      kind: "err",
      code: "timeout",
      message: "Child timed out after 30s",
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        output={output}
        state="output-error"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText(/Child timed out after 30s/)).toBeInTheDocument()
  })

  it("renders sub-session turns with markdown when detail is available", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "ok" }),
      detail: {
        summary: {
          id: 99,
          folder_id: 1,
          title: null,
          agent_type: "codex",
          status: "completed",
          model: null,
          git_branch: null,
          external_id: null,
          message_count: 1,
          created_at: "2026-05-23T00:00:00Z",
          updated_at: "2026-05-23T00:00:00Z",
        },
        turns: [
          {
            id: "u1",
            role: "user",
            blocks: [{ type: "text", text: "do something" }],
            timestamp: "2026-05-23T00:00:00Z",
          },
          {
            id: "a1",
            role: "assistant",
            blocks: [{ type: "text", text: "delegated answer body" }],
            timestamp: "2026-05-23T00:00:05Z",
          },
        ],
      },
      loading: false,
      error: null,
    })
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    // Collapsed card no longer surfaces the assistant's text in the header.
    expect(screen.queryByText("delegated answer body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Assistant")).toBeInTheDocument()
    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.getByText("delegated answer body")).toBeInTheDocument()
  })
})
