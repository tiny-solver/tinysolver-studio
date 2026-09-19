import { describe, expect, it } from "vitest"
import { applyCommands, createDemoDocument, parseDocument } from "./document"

describe("Studio document contract", () => {
  it("keeps documents engine independent and round-trips through JSON", () => {
    const document = createDemoDocument()
    expect(parseDocument(JSON.parse(JSON.stringify(document)))).toEqual(
      document
    )
  })

  it("applies an entire batch without changing its input", () => {
    const original = createDemoDocument()
    const next = applyCommands(original, [
      {
        type: "node.update",
        id: "signal",
        patch: { color: "#ffcc66", x: 120 },
      },
      { type: "document.update", patch: { name: "Lesson one" } },
    ])
    expect(next.nodes[1]).toMatchObject({ color: "#ffcc66", x: 120 })
    expect(next.name).toBe("Lesson one")
    expect(original).toEqual(createDemoDocument())
  })

  it("does not partially apply a batch with an invalid reference", () => {
    const original = createDemoDocument()
    expect(() =>
      applyCommands(original, [
        { type: "node.update", id: "signal", patch: { x: 120 } },
        {
          type: "node.update",
          id: "switch",
          patch: { toggleTarget: "missing" },
        },
      ])
    ).toThrow("Missing interaction target")
    expect(original).toEqual(createDemoDocument())
  })

  it("clears interaction references when their target is deleted", () => {
    const next = applyCommands(createDemoDocument(), [
      { type: "node.remove", id: "signal" },
    ])
    expect(
      next.nodes.find((n) => n.id === "switch")?.toggleTarget
    ).toBeUndefined()
    expect(next.nodes).toHaveLength(2)
  })

  it("reorders layers while preserving stable IDs and action targets", () => {
    const next = applyCommands(createDemoDocument(), [
      { type: "node.reorder", id: "signal", direction: "forward" },
    ])
    expect(next.nodes.map((n) => n.id)).toEqual(["panel", "switch", "signal"])
    expect(next.nodes[1].toggleTarget).toBe("signal")
  })

  it.each([NaN, Infinity, -Infinity, 8193])(
    "rejects unsafe coordinates %s",
    (x) => {
      expect(() =>
        applyCommands(createDemoDocument(), [
          { type: "node.update", id: "signal", patch: { x } },
        ])
      ).toThrow()
    }
  )

  it("rejects identity changes and arbitrary executable fields", () => {
    for (const patch of [
      { id: "replacement" },
      { onClick: "alert(1)" },
      { assetId: "remote-url" },
    ]) {
      expect(() =>
        applyCommands(createDemoDocument(), [
          { type: "node.update", id: "signal", patch },
        ])
      ).toThrow("Unsupported node field")
    }
  })

  it("rejects duplicate IDs and image nodes without an asset", () => {
    const document = createDemoDocument()
    expect(() =>
      applyCommands(document, [{ type: "node.add", node: document.nodes[0] }])
    ).toThrow("Duplicate node ID")
    expect(() =>
      applyCommands(document, [
        {
          type: "node.add",
          node: {
            ...document.nodes[0],
            id: "image",
            kind: "image",
            assetId: "absent",
          },
        },
      ])
    ).toThrow("Missing image asset")
  })

  it("validates document versions and background colors", () => {
    expect(() =>
      parseDocument({ ...createDemoDocument(), schemaVersion: 2 })
    ).toThrow("Unsupported document version")
    expect(() =>
      applyCommands(createDemoDocument(), [
        { type: "document.update", patch: { background: "url(example)" } },
      ])
    ).toThrow("#RRGGBB")
  })
})
