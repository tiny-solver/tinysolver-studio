import { describe, expect, it } from "vitest"
import {
  applyCommands,
  createStarterScene,
  fromLegacyProjectFile,
  nodeRect,
  parseScene,
  sceneActions,
} from "./document"

// A scene the way an agent writes one: engine-owned fields everywhere.
function agentScene() {
  return {
    schema: 1,
    id: "01-room",
    name: "첫 방",
    document: {
      container: { width: 1080, height: 1920 },
      grid: { tile: 120, cols: 9, rows: 12 },
      assets: [
        {
          id: "chest_closed",
          file: "characters/props/chest_closed_120x120.png",
          width: 120,
          height: 120,
          missing: true,
        },
      ],
      nodes: [
        {
          id: "chest",
          parent: "root",
          type: "sprite",
          transform: {
            x: 900,
            y: 840,
            w: 120,
            h: 120,
            anchor: "bottom-center",
            z: 30,
          },
          props: {
            asset: "chest_closed",
            interactive: true,
            onClick: "act_chest",
            tiles: [[7, 4]],
          },
        },
        {
          id: "panel",
          parent: "ui",
          type: "sprite",
          transform: {
            x: 0,
            y: 1420,
            w: 1080,
            h: 360,
            anchor: "top-left",
            z: 90,
          },
          props: { visible: false, modal: true },
        },
        {
          id: "line",
          parent: "panel",
          type: "text",
          transform: { x: 48, y: 48, w: 984, h: 264, z: 91 },
          props: { text: "", size: 44 },
        },
      ],
    },
    logic: { flags: { has_key: false }, lines: { chest: "열쇠" } },
  }
}

describe("scene document contract", () => {
  it("preserves engine-owned fields and defaults the core", () => {
    const scene = parseScene(agentScene())
    expect(scene.logic).toEqual(agentScene().logic)
    expect(scene.document.grid).toEqual({ tile: 120, cols: 9, rows: 12 })
    expect(scene.document.nodes[0].props.tiles).toEqual([[7, 4]])
    // Missing anchor/z default rather than fail.
    expect(scene.document.nodes[2].transform).toEqual({
      x: 48,
      y: 48,
      w: 984,
      h: 264,
      anchor: "top-left",
      z: 91,
    })
    expect(parseScene(JSON.parse(JSON.stringify(scene)))).toEqual(scene)
  })

  it("keys the file name over the inner name and requires ids", () => {
    expect(parseScene({ ...agentScene(), name: "" }).name).toBe("01-room")
    expect(() => parseScene({ ...agentScene(), id: "bad id" })).toThrow(
      "ids use"
    )
    expect(() => parseScene({ ...agentScene(), schema: 2 })).toThrow("schema")
  })

  it("computes absolute boxes through anchors and parents", () => {
    const scene = parseScene(agentScene())
    const [chest, panel, line] = scene.document.nodes
    expect(nodeRect(scene.document, chest)).toEqual({
      x: 840,
      y: 720,
      w: 120,
      h: 120,
    })
    // Unknown parent ("ui") means the container origin.
    expect(nodeRect(scene.document, panel)).toEqual({
      x: 0,
      y: 1420,
      w: 1080,
      h: 360,
    })
    expect(nodeRect(scene.document, line)).toEqual({
      x: 48,
      y: 1468,
      w: 984,
      h: 264,
    })
  })

  it("survives a parent cycle", () => {
    const scene = parseScene(agentScene())
    scene.document.nodes[1].parent = "line"
    expect(nodeRect(scene.document, scene.document.nodes[2]).x).toBe(48)
  })

  it("applies a batch atomically and merges props shallowly", () => {
    const original = parseScene(agentScene())
    const next = applyCommands(original, [
      {
        type: "node.update",
        id: "chest",
        transform: { x: 500 },
        props: { visible: false },
      },
      { type: "scene.update", name: "Room" },
    ])
    expect(next.document.nodes[0].transform).toMatchObject({
      x: 500,
      y: 840,
      anchor: "bottom-center",
    })
    expect(next.document.nodes[0].props).toEqual({
      asset: "chest_closed",
      interactive: true,
      onClick: "act_chest",
      tiles: [[7, 4]],
      visible: false,
    })
    expect(next.name).toBe("Room")
    expect(original).toEqual(parseScene(agentScene()))

    expect(() =>
      applyCommands(original, [
        { type: "node.update", id: "chest", transform: { x: 1 } },
        { type: "node.update", id: "nope", transform: { x: 1 } },
      ])
    ).toThrow("Node not found")
    expect(original).toEqual(parseScene(agentScene()))
  })

  it("removes a node with its descendants", () => {
    const next = applyCommands(parseScene(agentScene()), [
      { type: "node.remove", id: "panel" },
    ])
    expect(next.document.nodes.map((n) => n.id)).toEqual(["chest"])
  })

  it("reorders by z and rejects bad transforms", () => {
    const scene = parseScene(agentScene())
    const front = applyCommands(scene, [
      { type: "node.reorder", id: "chest", direction: "forward" },
    ])
    expect(front.document.nodes[0].transform.z).toBe(92)
    const back = applyCommands(scene, [
      { type: "node.reorder", id: "panel", direction: "backward" },
    ])
    expect(back.document.nodes[1].transform.z).toBe(29)
    for (const transform of [
      { x: NaN },
      { w: 0 },
      { anchor: "left" },
      { rotation: 1 },
    ]) {
      expect(() =>
        applyCommands(scene, [{ type: "node.update", id: "chest", transform }])
      ).toThrow()
    }
    expect(() =>
      applyCommands(scene, [
        { type: "node.add", node: scene.document.nodes[0] },
      ])
    ).toThrow("Duplicate node id")
  })

  it("rejects assets that escape the assets directory", () => {
    const scene = agentScene()
    scene.document.assets[0].file = "../secret.png"
    expect(() => parseScene(scene)).toThrow("relative to assets/")
  })

  it("converts the first prototype's project file", () => {
    const legacy = {
      format: "codeg-studio-project",
      version: 1,
      document: {
        schemaVersion: 1,
        id: "first-scene",
        name: "Signal lab",
        width: 960,
        height: 540,
        background: "#161d2d",
        assets: [
          {
            id: "abc",
            name: "a.png",
            mime: "image/png",
            width: 10,
            height: 10,
            size: 5,
          },
        ],
        nodes: [
          {
            id: "signal",
            name: "Signal",
            kind: "ellipse",
            x: 420,
            y: 145,
            width: 120,
            height: 120,
            color: "#c6f28b",
            visible: true,
          },
          {
            id: "switch",
            name: "Switch",
            kind: "rectangle",
            x: 365,
            y: 320,
            width: 230,
            height: 64,
            color: "#8b9cf7",
            visible: true,
            toggleTarget: "signal",
          },
          {
            id: "pic",
            name: "Pic",
            kind: "image",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            color: "#ffffff",
            visible: true,
            assetId: "abc",
          },
        ],
      },
    }
    const scene = fromLegacyProjectFile(legacy)!
    expect(scene.id).toBe("first-scene")
    expect(scene.document.container).toEqual({ width: 960, height: 540 })
    expect(scene.document.assets[0]).toMatchObject({
      file: "legacy/abc.png",
      missing: true,
    })
    const ids = scene.document.nodes.map((n) => n.id)
    expect(ids).toEqual(["background", "signal", "switch", "pic"])
    expect(scene.document.nodes[2].props).toMatchObject({
      interactive: true,
      onClick: "toggle_switch",
    })
    expect(scene.logic).toEqual({
      actions: { toggle_switch: [{ op: "toggle", id: "signal" }] },
    })
    expect(scene.document.nodes[3].type).toBe("sprite")
    expect(fromLegacyProjectFile(agentScene())).toBeNull()
  })

  it("starter scene validates", () => {
    const scene = createStarterScene("main", "첫 장면")
    expect(parseScene(scene)).toEqual(scene)
  })
})

describe("action commands", () => {
  it("sets and removes logic.actions entries atomically", () => {
    const scene = parseScene(agentScene())
    const before = JSON.stringify(scene)
    const next = applyCommands(scene, [
      {
        type: "action.set",
        name: "act_open",
        steps: [
          { op: "swapAsset", id: "chest", asset: "chest_open" },
          { op: "add", key: "coins", value: 3, if: { key: "hasKey" } },
        ],
      },
    ])
    expect(sceneActions(next).act_open).toHaveLength(2)
    expect(sceneActions(next).act_open[1].if).toEqual({ key: "hasKey" })
    // Whatever else lived under logic is still there.
    expect(Object.keys(sceneActions(next))).toEqual(
      expect.arrayContaining(Object.keys(sceneActions(scene)))
    )
    expect(JSON.stringify(scene)).toBe(before)

    const removed = applyCommands(next, [
      { type: "action.remove", name: "act_open" },
    ])
    expect(sceneActions(removed).act_open).toBeUndefined()

    expect(() =>
      applyCommands(scene, [
        { type: "action.set", name: "bad name", steps: [] },
      ])
    ).toThrow(/action name/)
    expect(() =>
      applyCommands(scene, [
        { type: "action.set", name: "a", steps: [{ id: "chest" }] },
      ])
    ).toThrow(/steps\[0\]\.op/)
    expect(() =>
      applyCommands(scene, [{ type: "action.set", name: "a", steps: "say hi" }])
    ).toThrow(/steps/)
  })

  it("creates logic when the scene has none", () => {
    const bare = parseScene({
      id: "bare",
      document: { container: { width: 100, height: 100 }, nodes: [] },
    })
    const next = applyCommands(bare, [
      { type: "action.set", name: "hi", steps: [{ op: "say", text: "hi" }] },
    ])
    expect(sceneActions(next)).toEqual({ hi: [{ op: "say", text: "hi" }] })
    expect(sceneActions(bare)).toEqual({})
  })
})
