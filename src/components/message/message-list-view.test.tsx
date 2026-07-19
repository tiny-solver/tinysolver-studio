import { describe, expect, it } from "vitest"

import {
  mergeConsecutiveAssistantTurns,
  singletonSourceTurns,
  type MergedAssistantRunCache,
  type ResolvedMessageGroup,
  type ThreadRenderItem,
} from "./message-list-view"
import type { MessageTurn } from "@/lib/types"

function turn(id: string): MessageTurn {
  return { id, role: "assistant", blocks: [], timestamp: "" }
}

describe("singletonSourceTurns", () => {
  it("returns the same array reference for the same turn", () => {
    const t = turn("t1")
    const first = singletonSourceTurns(t)
    const second = singletonSourceTurns(t)
    // Reference stability is the whole point: it lets HistoricalMessageGroup's
    // memo bail out when an unchanged historical turn re-renders per token.
    expect(first).toBe(second)
    expect(first).toEqual([t])
  })

  it("returns distinct arrays for distinct turns", () => {
    const a = singletonSourceTurns(turn("a"))
    const b = singletonSourceTurns(turn("b"))
    expect(a).not.toBe(b)
  })
})

function makeGroup(
  role: "user" | "assistant",
  id: string
): ResolvedMessageGroup {
  return { id, role, parts: [], resources: [], images: [] }
}

// Fresh render-item objects per call, like the rawItems map in threadItems —
// only `group`, `key`, and the sourceTurns wrapper carry identity.
function makeItem(
  group: ResolvedMessageGroup,
  index: number,
  phase: "persisted" | "optimistic" | "streaming" = "persisted"
): ThreadRenderItem {
  return {
    key: `${phase}-${group.id}-${index}`,
    kind: "turn",
    group,
    phase,
    showStats: false,
    isRoleTransition: false,
    previousUserIndex: null,
    sourceTurns: singletonSourceTurns(turn(group.id)),
  }
}

function makeUserItem(id: string, index: number): ThreadRenderItem {
  const item = makeItem(makeGroup("user", id), index)
  if (item.kind === "turn") {
    item.group.parts = [{ type: "text", text: "hi" }]
  }
  return item
}

describe("mergeConsecutiveAssistantTurns merged-run cache", () => {
  it("reuses the merged item (group/parts/sourceTurns) when membership is unchanged", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )

    expect(out1).toHaveLength(1)
    const first = out1[0]
    const second = out2[0]
    if (first.kind !== "turn" || second.kind !== "turn") {
      throw new Error("expected turn items")
    }
    expect(second).toBe(first)
    expect(second.group).toBe(first.group)
    expect(second.group.parts).toBe(first.group.parts)
    expect(second.sourceTurns).toBe(first.sourceTurns)
    expect(first.key).toBe("merged-persisted-a1-0")
    expect(first.group.id).toBe("a1")
  })

  it("rebuilds a run whose member changed without touching a neighboring run", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const g3 = makeGroup("assistant", "a3")
    const g4 = makeGroup("assistant", "a4")

    const out1 = mergeConsecutiveAssistantTurns(
      [
        makeItem(g1, 0),
        makeItem(g2, 1),
        makeUserItem("u1", 2),
        makeItem(g3, 3),
        makeItem(g4, 4),
      ],
      cache
    )
    // Second member of run A re-adapted (new group object, e.g. its turn was
    // reloaded); run B untouched.
    const g2b = makeGroup("assistant", "a2")
    const out2 = mergeConsecutiveAssistantTurns(
      [
        makeItem(g1, 0),
        makeItem(g2b, 1),
        makeUserItem("u1", 2),
        makeItem(g3, 3),
        makeItem(g4, 4),
      ],
      cache
    )

    expect(out2[0]).not.toBe(out1[0])
    expect(out2[2]).toBe(out1[2])
  })

  it("misses when the run gains a member, then caches the new membership", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const g3 = makeGroup("assistant", "a3")

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1), makeItem(g3, 2)],
      cache
    )
    const out3 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), makeItem(g2, 1), makeItem(g3, 2)],
      cache
    )

    expect(out2[0]).not.toBe(out1[0])
    expect(out3[0]).toBe(out2[0])
  })

  it("keeps cache hits across interleaved empty (skipped) turn items", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")
    const emptyUser = () => makeItem(makeGroup("user", "empty"), 1)

    const out1 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), emptyUser(), makeItem(g2, 2)],
      cache
    )
    const out2 = mergeConsecutiveAssistantTurns(
      [makeItem(g1, 0), emptyUser(), makeItem(g2, 2)],
      cache
    )

    // The empty user turn is transparent: one merged item, no user item.
    expect(out1).toHaveLength(1)
    expect(out2[0]).toBe(out1[0])
  })

  it("passes single-turn runs through untouched without caching", () => {
    const cache: MergedAssistantRunCache = new WeakMap()
    const item = makeItem(makeGroup("assistant", "solo"), 0)

    const out = mergeConsecutiveAssistantTurns([item], cache)

    expect(out).toHaveLength(1)
    expect(out[0]).toBe(item)
  })

  it("still merges correctly without a cache", () => {
    const g1 = makeGroup("assistant", "a1")
    const g2 = makeGroup("assistant", "a2")

    const out1 = mergeConsecutiveAssistantTurns([
      makeItem(g1, 0),
      makeItem(g2, 1),
    ])
    const out2 = mergeConsecutiveAssistantTurns([
      makeItem(g1, 0),
      makeItem(g2, 1),
    ])

    expect(out1).toHaveLength(1)
    expect(out2[0]).not.toBe(out1[0])
    expect(out2[0]).toEqual(out1[0])
  })
})
