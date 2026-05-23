import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DelegatedSubThread } from "./delegated-sub-thread"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

// DelegatedSubThread now reads child live state from the connections
// store (Phase B+E) and routes delegation-child attach/detach through
// the actions context. Tests assert *component* behavior, not provider
// wiring — so we stub the contexts directly here.
const mockFindByParentToolUseId = vi.fn()
const mockAttachDelegationChild = vi.fn()
const mockDetachDelegationChild = vi.fn()
const mockRespondPermission = vi.fn()
let mockChildConnection: unknown = undefined

vi.mock("@/contexts/delegation-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/delegation-context")
  >("@/contexts/delegation-context")
  return {
    ...actual,
    useDelegation: () => ({
      findByParentToolUseId: mockFindByParentToolUseId,
      findByChildConversationId: vi.fn(),
    }),
  }
})

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useAcpActions: () => ({
      // Only the members DelegatedSubThread reads — other actions can
      // be omitted because the component never touches them.
      attachDelegationChild: mockAttachDelegationChild,
      detachDelegationChild: mockDetachDelegationChild,
      respondPermission: mockRespondPermission,
    }),
    useConnectionStore: () => ({
      // Subscribe is a no-op; getConnection returns whatever the test
      // configured for the synthetic child entry.
      subscribeKey: () => () => {},
      getConnection: () => mockChildConnection,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
    }),
  }
})

// PermissionDialog has its own dependency graph (parsePermissionToolCall,
// CodeBlock, UnifiedDiffPreview…). Mock it down to a sentinel so we can
// assert it rendered without booting all of that.
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: ({
    permission,
  }: {
    permission: { request_id: string } | null
  }) =>
    permission ? (
      <div data-testid="permission-dialog">
        permission for {permission.request_id}
      </div>
    ) : null,
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
  beforeEach(() => {
    mockFindByParentToolUseId.mockReset()
    mockAttachDelegationChild.mockReset()
    mockDetachDelegationChild.mockReset()
    mockRespondPermission.mockReset()
    mockChildConnection = undefined
    // Default: no live binding from the in-memory context. Individual
    // tests can override per case.
    mockFindByParentToolUseId.mockReturnValue(undefined)
  })

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

  it("does NOT show the running indicator once the tool reached output-available, even if output is an empty string", () => {
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
    expect(screen.queryByText(/Sub-agent running/)).not.toBeInTheDocument()
    // Falls back to the "no detail" copy instead of a misleading indicator.
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

  it("does not surface the child's intermediate turns — only the broker's final outcome appears in the expanded body", () => {
    // Persisted child turns (text + tool_use interleaved) used to leak
    // into the parent's expanded body via SubThreadPreview. That replay
    // pollutes context for the user — the MCP `delegate_to_agent` round
    // trip only returns the final result, and the parent UI must match.
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
            blocks: [{ type: "text", text: "intermediate reasoning" }],
            timestamp: "2026-05-23T00:00:05Z",
          },
        ],
      },
      loading: false,
      error: null,
    })
    const output = JSON.stringify({
      kind: "ok",
      text: "Final result body.",
      child_conversation_id: 99,
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        output={output}
        state="output-available"
      />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Final result body.")).toBeInTheDocument()
    // Intermediate child turns must not leak into the parent's expanded
    // body — neither the User/Assistant labels nor the intermediate text.
    expect(screen.queryByText("User")).not.toBeInTheDocument()
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument()
    expect(screen.queryByText("intermediate reasoning")).not.toBeInTheDocument()
  })

  it("uses meta.codeg.delegation to re-attach the child for live updates when the live binding is missing", () => {
    // No live binding (page refresh mid-delegation), but the parent's
    // tool-call snapshot carries meta — the component must dispatch a
    // delegation-child attach so the child's streaming text can still
    // reach the parent UI via the reducer.
    mockedHook.mockReturnValue({
      binding: undefined,
      detail: null,
      loading: false,
      error: null,
    })
    const inputJson = JSON.stringify({
      agent_type: "codex",
      task: "do a thing",
    })
    renderWithIntl(
      <DelegatedSubThread
        parentToolUseId="pt-1"
        input={inputJson}
        meta={{
          "codeg.delegation": {
            status: "running",
            child_connection_id: "child-conn-meta",
            child_conversation_id: 77,
          },
        }}
      />
    )
    expect(mockAttachDelegationChild).toHaveBeenCalledWith({
      connectionId: "child-conn-meta",
      parentConnectionId: "",
      parentToolUseId: "pt-1",
      agentType: "codex",
    })
  })

  it("real-time renders every text segment append-only + a 'sub-agent running' indicator below (never thinking, never tool_calls); subsequent segments never overwrite earlier ones", () => {
    // The parent UI accumulates the child's assistant text segments
    // in arrival order — each new "I'll do X" / "Now I'll do Y" stacks
    // below the previous, never replaces it. A 'sub-agent running'
    // indicator hangs off the bottom while status is "running".
    // Hidden categories:
    //   - thinking blocks (internal reasoning)
    //   - tool_call blocks (intermediate steps)
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    const baseChildConn = {
      connectionId: "c1",
      contextKey: "c1",
      agentType: "codex",
      workingDir: null,
      status: "connected",
      promptCapabilities: {
        image: false,
        audio: false,
        embedded_context: false,
      },
      supportsFork: false,
      selectorsReady: true,
      sessionId: null,
      modes: null,
      configOptions: null,
      availableCommands: null,
      usage: null,
      pendingPermission: null,
      pendingQuestion: null,
      claudeApiRetry: null,
      error: null,
      loadError: null,
      lastAppliedSeq: 0,
      isDelegationChild: true,
      parentToolUseId: "pt-1",
      parentConnectionId: "p1",
    }

    // Case 1: multiple text segments interleaved with thinking + tool_call.
    // Every text segment appears (in order); non-text categories are
    // filtered out; the running indicator is appended below.
    mockChildConnection = {
      ...baseChildConn,
      liveMessage: {
        id: "lm-1",
        role: "assistant",
        content: [
          { type: "thinking", text: "deliberating..." },
          {
            type: "tool_call",
            info: { title: "Run bash", kind: "execute", status: "completed" },
          },
          { type: "text", text: "preamble text" },
          { type: "text", text: "final tail text" },
        ],
        startedAt: Date.now(),
      },
    }
    const { unmount } = renderWithIntl(
      <DelegatedSubThread parentToolUseId="pt-1" />
    )
    fireEvent.click(screen.getByRole("button"))
    // Both text segments must be visible — later segments NEVER cover
    // earlier ones. Segments are joined directly with no separator, so
    // the rendered string contains both substrings in arrival order.
    expect(screen.getByText(/preamble text/)).toBeInTheDocument()
    expect(screen.getByText(/final tail text/)).toBeInTheDocument()
    expect(screen.queryByText("deliberating...")).not.toBeInTheDocument()
    expect(screen.queryByText(/Run bash/)).not.toBeInTheDocument()
    // While status is "running" the indicator is appended below the
    // text — it must coexist with the rendered text, never replace it.
    expect(screen.getByText(/Sub-agent running/)).toBeInTheDocument()
    unmount()

    // Case 2: tail block is a tool_call (child mid-tool, hasn't started
    // the next text segment yet). The previous text persists AND the
    // running indicator stays below it — neither flickers off, nor
    // hides the other.
    mockChildConnection = {
      ...baseChildConn,
      liveMessage: {
        id: "lm-2",
        role: "assistant",
        content: [
          { type: "text", text: "earlier text" },
          {
            type: "tool_call",
            info: { title: "Run bash", kind: "execute", status: "in_progress" },
          },
        ],
        startedAt: Date.now(),
      },
    }
    const { unmount: unmount2 } = renderWithIntl(
      <DelegatedSubThread parentToolUseId="pt-1" />
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("earlier text")).toBeInTheDocument()
    expect(screen.getByText(/Sub-agent running/)).toBeInTheDocument()
    expect(screen.queryByText(/Run bash/)).not.toBeInTheDocument()
    unmount2()

    // Case 3: no text yet, only tool_calls — only the running indicator
    // is visible (the previous "waitingForChild" wording is gone).
    mockChildConnection = {
      ...baseChildConn,
      liveMessage: {
        id: "lm-3",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            info: { title: "Run bash", kind: "execute", status: "in_progress" },
          },
        ],
        startedAt: Date.now(),
      },
    }
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText(/Sub-agent running/)).toBeInTheDocument()
    expect(
      screen.queryByText(/Waiting for the child agent to start/)
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Run bash/)).not.toBeInTheDocument()
  })

  it("surfaces the child's pending permission inline and auto-expands the card", () => {
    mockedHook.mockReturnValue({
      binding: bindingOf({ status: "running" }),
      detail: null,
      loading: false,
      error: null,
    })
    mockChildConnection = {
      connectionId: "c1",
      contextKey: "c1",
      agentType: "codex",
      workingDir: null,
      status: "connected",
      promptCapabilities: {
        image: false,
        audio: false,
        embedded_context: false,
      },
      supportsFork: false,
      selectorsReady: true,
      sessionId: null,
      modes: null,
      configOptions: null,
      availableCommands: null,
      usage: null,
      liveMessage: null,
      pendingPermission: {
        request_id: "req-9",
        tool_call: { title: "Run bash", kind: "execute" },
        options: [
          { id: "approve", label: "Approve", kind: "allow_once" },
          { id: "deny", label: "Deny", kind: "reject_once" },
        ],
      },
      pendingQuestion: null,
      claudeApiRetry: null,
      error: null,
      loadError: null,
      lastAppliedSeq: 0,
      isDelegationChild: true,
      parentToolUseId: "pt-1",
      parentConnectionId: "p1",
    }
    renderWithIntl(<DelegatedSubThread parentToolUseId="pt-1" />)
    // No manual click — the card should have auto-expanded on first
    // appearance of pendingPermission. The mocked PermissionDialog
    // renders a sentinel that asserts its mount.
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()
    expect(screen.getByText("permission for req-9")).toBeInTheDocument()
  })
})
