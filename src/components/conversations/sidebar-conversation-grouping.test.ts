import { describe, expect, it } from "vitest"
import type { DbConversationSummary } from "@/lib/types"
import {
  formatRelative,
  groupByFolderWithReuse,
  reuseSelected,
  reuseSet,
} from "./sidebar-conversation-grouping"

const MINUTE = 60_000

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const createdAt = new Date(1_700_000_000_000 + id * MINUTE).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    agent_type: "claude_code",
    status: "pending",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
}

describe("formatRelative", () => {
  const now = 1_700_000_000_000

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatRelative("", now)).toBe("")
    expect(formatRelative("not-a-date", now)).toBe("")
  })

  it("buckets the elapsed time into compact units", () => {
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe(
      "now"
    )
    expect(formatRelative(new Date(now - 5 * MINUTE).toISOString(), now)).toBe(
      "5m"
    )
    expect(
      formatRelative(new Date(now - 3 * 60 * MINUTE).toISOString(), now)
    ).toBe("3h")
    expect(
      formatRelative(new Date(now - 2 * 24 * 60 * MINUTE).toISOString(), now)
    ).toBe("2d")
  })

  it("is deterministic for a given `now` regardless of the wall clock", () => {
    const iso = new Date(now - 5 * MINUTE).toISOString()
    // Same inputs → identical string, which is what keeps the card memo hit
    // across re-renders within one minute.
    expect(formatRelative(iso, now)).toBe(formatRelative(iso, now))
  })

  it("ages the label when `now` crosses a unit boundary", () => {
    const iso = new Date(now - 59 * MINUTE).toISOString()
    expect(formatRelative(iso, now)).toBe("59m")
    expect(formatRelative(iso, now + MINUTE)).toBe("1h")
  })
})

describe("groupByFolderWithReuse", () => {
  it("groups by folder and sorts each bucket by created-at descending", () => {
    const list = [conv(1, 10), conv(3, 10), conv(2, 20), conv(4, 10)]
    const grouped = groupByFolderWithReuse(list, "created", new Map())

    expect([...grouped.keys()].sort()).toEqual([10, 20])
    expect(grouped.get(10)!.map((c) => c.id)).toEqual([4, 3, 1])
    expect(grouped.get(20)!.map((c) => c.id)).toEqual([2])
  })

  it("sorts by updated-at descending in updated mode", () => {
    const a = conv(1, 10, { updated_at: new Date(1000).toISOString() })
    const b = conv(2, 10, { updated_at: new Date(5000).toISOString() })
    const grouped = groupByFolderWithReuse([a, b], "updated", new Map())
    expect(grouped.get(10)!.map((c) => c.id)).toEqual([2, 1])
  })

  it("reuses the prior bucket array for folders whose membership is unchanged", () => {
    const a1 = conv(1, 10)
    const a2 = conv(2, 10)
    const b1 = conv(3, 20)
    const first = groupByFolderWithReuse([a1, a2, b1], "created", new Map())

    // Simulate a status event on folder 10: one summary is replaced by a new
    // object (slice + spread), every other summary keeps its identity.
    const a2Patched = { ...a2, status: "completed" }
    const second = groupByFolderWithReuse([a1, a2Patched, b1], "created", first)

    // Folder 20 is untouched → same array reference (memo can bail out).
    expect(second.get(20)).toBe(first.get(20))
    // Folder 10 changed → a fresh array reference.
    expect(second.get(10)).not.toBe(first.get(10))
    // …but the untouched summary inside folder 10 keeps its object identity,
    // so its card memo still bails out.
    expect(second.get(10)).toContain(a1)
    expect(second.get(10)).toContain(a2Patched)
    expect(second.get(10)).not.toContain(a2)
  })

  it("reuses every bucket when nothing changed at all", () => {
    const list = [conv(1, 10), conv(2, 20)]
    const first = groupByFolderWithReuse(list, "created", new Map())
    const second = groupByFolderWithReuse(list, "created", first)
    expect(second.get(10)).toBe(first.get(10))
    expect(second.get(20)).toBe(first.get(20))
  })
})

describe("reuseSet", () => {
  it("returns the previous set when membership is unchanged", () => {
    const prev = new Set(["a:1", "b:2"])
    const next = new Set(["b:2", "a:1"])
    expect(reuseSet(prev, next)).toBe(prev)
  })

  it("returns the next set when membership differs", () => {
    const prev = new Set(["a:1"])
    expect(reuseSet(prev, new Set(["a:1", "b:2"]))).not.toBe(prev)
    expect(reuseSet(new Set(["a:1", "b:2"]), new Set(["a:1"]))).toEqual(
      new Set(["a:1"])
    )
    expect(reuseSet(new Set(["a:1"]), new Set(["b:2"]))).toEqual(
      new Set(["b:2"])
    )
  })
})

describe("reuseSelected", () => {
  it("returns the previous ref when it denotes the same conversation", () => {
    const prev = { id: 1, agentType: "claude_code" }
    expect(reuseSelected(prev, { id: 1, agentType: "claude_code" })).toBe(prev)
  })

  it("returns the next value when the selection changed or cleared", () => {
    const prev = { id: 1, agentType: "claude_code" }
    expect(reuseSelected(prev, { id: 2, agentType: "claude_code" })).toEqual({
      id: 2,
      agentType: "claude_code",
    })
    expect(reuseSelected(prev, { id: 1, agentType: "codex" })).toEqual({
      id: 1,
      agentType: "codex",
    })
    expect(reuseSelected(prev, null)).toBeNull()
    expect(reuseSelected(null, prev)).toBe(prev)
  })
})
