import { describe, expect, it } from "vitest"

import {
  buildAgentContext,
  MAX_ENGINE_ERRORS,
  pushEngineError,
} from "./agent-context"
import { parseScene } from "./document"

const scene = parseScene({
  schema: 1,
  id: "main",
  name: "첫 장면",
  document: {
    container: { width: 1080, height: 1920 },
    assets: [],
    nodes: [
      {
        id: "hero",
        parent: "root",
        type: "sprite",
        transform: {
          x: 540,
          y: 1500,
          w: 120,
          h: 180,
          anchor: "bottom-center",
          z: 20,
        },
        props: { asset: "hero_idle", onClick: "act_hero" },
      },
    ],
  },
})

describe("buildAgentContext", () => {
  it("names the scene, the selected node and the tool to use", () => {
    const text = buildAgentContext({
      projectName: "my-story",
      scenePath: "outputs/game/content/main.studio.json",
      scene,
      selected: scene.document.nodes[0],
      hot: true,
      engineErrors: [],
    })
    expect(text).toContain("[Codeg Studio · project my-story] Scene `main`")
    expect(text).toContain(
      "outputs/game/content/main.studio.json (1080×1920, 1 nodes)"
    )
    expect(text).toContain("live (edits render instantly)")
    expect(text).toContain(
      "Selected node `hero` (sprite): x=540 y=1500 w=120 h=180 anchor=bottom-center z=20 parent=root"
    )
    expect(text).toContain('"onClick":"act_hero"')
    expect(text).toContain("studio_apply_scene_commands")
    expect(text.endsWith("\n\n")).toBe(true)
    expect(text).not.toContain("Runtime errors")
  })

  it("says so when nothing is selected and the engine reloads", () => {
    const text = buildAgentContext({
      scenePath: "outputs/game/content/main.studio.json",
      scene,
      selected: null,
      hot: false,
    })
    expect(text).toContain("No node is selected.")
    expect(text).toContain("reloads after save")
  })

  it("describes the game view and folds multi-line errors", () => {
    const text = buildAgentContext({
      gameDir: "outputs/game",
      engineErrors: ["x is not defined\n  at main.js:12:3"],
    })
    expect(text).toContain("Game preview of outputs/game/")
    expect(text).toContain("- x is not defined ⏎ at main.js:12:3")
  })

  it("caps very large props", () => {
    const big = structuredClone(scene.document.nodes[0])
    big.props.blob = "a".repeat(5000)
    const text = buildAgentContext({
      scenePath: "p",
      scene,
      selected: big,
    })
    expect(text.length).toBeLessThan(1500)
    expect(text).toContain("…")
  })
})

describe("pushEngineError", () => {
  it("dedupes, moves repeats to the end and keeps the last few", () => {
    let list: string[] = []
    list = pushEngineError(list, "a")
    expect(pushEngineError(list, "a")).toBe(list)
    expect(pushEngineError(list, "  ")).toBe(list)
    list = pushEngineError(list, "b")
    list = pushEngineError(list, "a")
    expect(list).toEqual(["b", "a"])
    for (let i = 0; i < 10; i++) list = pushEngineError(list, `e${i}`)
    expect(list).toHaveLength(MAX_ENGINE_ERRORS)
    expect(list[list.length - 1]).toBe("e9")
  })
})
