import { describe, expect, it } from "vitest"

import {
  newFlow,
  nextStep,
  parseFlow,
  planSteps,
  projectNameFor,
  recordOf,
  stepOp,
  withoutStepsFrom,
  type StudioFlow,
} from "./flow"

const at = new Date("2026-10-09T05:00:00Z")
const done = (material: string, stills?: string[]) => ({
  status: "done" as const,
  material,
  ...(stills ? { stills } : {}),
  at: at.toISOString(),
})

describe("planSteps", () => {
  it("follows the decided card order", () => {
    expect(planSteps("video", false)).toEqual([
      "image",
      "model",
      "camera",
      "render",
      "video",
    ])
  })
  it("puts a T-pose before the lift and bones after it for a character", () => {
    expect(planSteps("video", true)).toEqual([
      "image",
      "tpose",
      "model",
      "rig",
      "camera",
      "render",
      "video",
    ])
    expect(planSteps("model", true)).toEqual(["image", "tpose", "model", "rig"])
    expect(planSteps("scene", true)).toEqual(["image", "tpose", "model"])
  })
  it("stops at the picture for an image", () => {
    expect(planSteps("image", true)).toEqual(["image"])
  })
})

describe("stepOp", () => {
  const flow = (steps: StudioFlow["steps"], character = false) => ({
    ...newFlow("a small blue teacup", "video", character, at),
    steps,
  })

  it("draws first, then waits for each input", () => {
    expect(stepOp("image", flow({}))).toMatchObject({
      op: "generate_asset",
      kind: "image",
      prompt: "a small blue teacup",
      id: "a-small-blue-teacup",
    })
    expect(stepOp("model", flow({}))).toBeNull()
    expect(stepOp("video", flow({}))).toBeNull()
  })

  it("lifts the T-pose when there is one, at a character budget", () => {
    const f = flow({ image: done("hero"), tpose: done("hero-tpose") }, true)
    expect(stepOp("model", f)).toEqual({
      op: "generate_asset",
      kind: "3d",
      from: "hero-tpose",
      use: "mobile-character",
    })
  })

  it("renders the rigged model walking, the plain one turning", () => {
    const plain = flow({ model: done("cup-3d") })
    expect(stepOp("render", plain)).toMatchObject({
      op: "render_asset",
      from: "cup-3d",
      mode: "turntable",
    })
    const rigged = flow({ model: done("hero-3d"), rig: done("hero-rig") }, true)
    expect(stepOp("render", rigged)).toMatchObject({
      from: "hero-rig",
      mode: "walk",
    })
    expect(stepOp("camera", rigged)).toMatchObject({
      from: "hero-rig",
      mode: "still",
    })
  })

  it("animates the render's first still with the motion prompt", () => {
    const f = flow({
      render: done("cup-turntable", ["cup-turntable-f001"]),
    })
    expect(stepOp("video", f)).toEqual({
      op: "generate_asset",
      kind: "video",
      from: "cup-turntable-f001",
      prompt: f.motion,
    })
    expect(stepOp("video", { ...f, motion: "  " })).toBeNull()
  })
})

describe("records", () => {
  it("reads the material out of either outcome shape", () => {
    expect(recordOf({ ok: true, asset: { id: "cup" } }, at).material).toBe(
      "cup"
    )
    const render = recordOf(
      {
        ok: true,
        video: { id: "cup-turntable" },
        keyframes: [{ id: "cup-turntable-f001" }],
      },
      at
    )
    expect(render).toMatchObject({
      material: "cup-turntable",
      stills: ["cup-turntable-f001"],
    })
    expect(recordOf({ ok: false, note: "no Blender" }, at)).toEqual({
      status: "failed",
      note: "no Blender",
      at: at.toISOString(),
    })
  })

  it("moves on to the first unfinished step and clears what follows a rerun", () => {
    const f = {
      ...newFlow("cup", "video", false, at),
      steps: { image: done("cup"), model: done("cup-3d") },
    }
    expect(nextStep(f)).toBe("camera")
    const rerun = withoutStepsFrom(f, "model")
    expect(Object.keys(rerun.steps)).toEqual(["image"])
    expect(nextStep(rerun)).toBe("model")
  })

  it("parses only flows it knows", () => {
    const f = newFlow("cup", "image", false, at)
    expect(parseFlow(JSON.parse(JSON.stringify(f)))).toEqual(f)
    expect(parseFlow({ schema: 2, prompt: "x", goal: "image" })).toBeNull()
    expect(parseFlow(null)).toBeNull()
  })
})

describe("projectNameFor", () => {
  it("keeps ascii words, else dates the folder", () => {
    expect(projectNameFor("A Knight with a red cape!")).toBe("a-knight-with-a")
    expect(projectNameFor("빨간 망토 기사", at)).toMatch(/^studio-20261009-/)
  })
})
