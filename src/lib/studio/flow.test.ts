import { describe, expect, it } from "vitest"

import {
  choiceKey,
  imageChoiceOf,
  modelChoice,
  newFlow,
  nextStep,
  parseFlow,
  planSteps,
  projectNameFor,
  recordOf,
  stepOp,
  withOption,
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

describe("step options", () => {
  const base = () => ({
    ...newFlow("a small blue teacup", "video", false, at),
    steps: {
      image: done("cup"),
      model: done("cup-3d"),
      render: done("cup-turn", ["cup-f001"]),
    },
  })

  it("draws with the generator default until a picture model is chosen", () => {
    const op = stepOp("image", base())
    expect(op).not.toHaveProperty("provider")
    expect(op).not.toHaveProperty("workflow")
  })

  it("passes a cloud picture model as provider + model, a workflow as is", () => {
    const banana = withOption(base(), "image", {
      provider: "openrouter",
      model: "google/gemini-nano-banana-2.1",
    })
    expect(stepOp("image", banana)).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-nano-banana-2.1",
    })
    expect(stepOp("image", banana)).not.toHaveProperty("workflow")
    const codex = newFlow("a cup", "image", false, at, {
      provider: "codex",
    })
    expect(stepOp("image", codex)).toMatchObject({ provider: "codex" })
    const flux = withOption(base(), "image", {
      provider: "comfyui",
      workflow: "flux2-klein-4b",
    })
    expect(stepOp("image", flux)).toMatchObject({
      provider: "comfyui",
      workflow: "flux2-klein-4b",
    })
  })

  it("lifts with the chosen faces and texture, else the defaults", () => {
    expect(stepOp("model", base())).toMatchObject({
      target_faces: 10000,
      texture_size: 1024,
    })
    expect(modelChoice({ ...base(), character: true })).toEqual({
      use: "mobile-character",
    })
    const chosen = withOption(base(), "model", {
      use: "pc-hero",
      target_faces: 80000,
      texture_size: 4096,
      compress_textures: true,
    })
    expect(stepOp("model", chosen)).toMatchObject({
      kind: "3d",
      from: "cup",
      use: "pc-hero",
      target_faces: 80000,
      texture_size: 4096,
      compress_textures: true,
    })
  })

  it("animates with the chosen workflow and length", () => {
    const v = withOption(base(), "video", {
      workflow: "minimax-h3-i2v-turbo",
      duration: 8,
    })
    expect(stepOp("video", v)).toMatchObject({
      kind: "video",
      from: "cup-f001",
      workflow: "minimax-h3-i2v-turbo",
      duration: 8,
    })
    expect(withOption(v, "video", undefined).options).toEqual({})
  })

  it("keys and strips choices the same way for every provider", () => {
    expect(
      choiceKey({ provider: "comfyui", workflow: "qwen-image-21-rgba" })
    ).toBe("comfyui:qwen-image-21-rgba")
    expect(choiceKey({ provider: "codex" })).toBe("codex:")
    expect(
      imageChoiceOf({
        provider: "openrouter",
        model: "google/gemini-3-pro-image",
        label: "Nano Banana Pro",
        billing: "metered",
        usd: null,
      })
    ).toEqual({ provider: "openrouter", model: "google/gemini-3-pro-image" })
  })

  it("survives a round trip through the file", () => {
    const f = withOption(base(), "image", { provider: "codex" })
    expect(parseFlow(JSON.parse(JSON.stringify(f)))?.options).toEqual({
      image: { provider: "codex" },
    })
  })
})
