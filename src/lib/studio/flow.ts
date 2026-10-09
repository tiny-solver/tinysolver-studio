import type {
  StudioImageChoice,
  StudioImageProvider,
  StudioOp,
  StudioOutcome,
} from "@/lib/types"

/**
 * The first screen's making flow: what the person asked for, which steps it
 * takes, and which material each step left behind. Kept in the project as
 * `studio-flow.json` (`read_flow` / `write_flow`), so the cards come back
 * when the project is reopened and an agent can read where things stand.
 *
 * Every step runs an operation the material drawer and the `studio_*` MCP
 * tools run too — a card is a button on the same command, nothing more.
 */

export type FlowGoal = "video" | "model" | "image" | "scene"

export const FLOW_GOALS: FlowGoal[] = ["video", "model", "image", "scene"]

export type FlowStepId =
  | "image"
  | "tpose"
  | "model"
  | "rig"
  | "camera"
  | "render"
  | "video"

export interface FlowCamera {
  yaw: number
  pitch: number
  cam_dist: number
}

export interface FlowStepRecord {
  status: "done" | "failed"
  /** The material the step made (the clip, for a render). */
  material?: string
  /** A render's stills, first frame first. */
  stills?: string[]
  note?: string
  /** Wall time the step took. */
  seconds?: number
  at: string
}

/** Who draws the picture: a generator workflow, or a cloud model. */
export interface FlowImageChoice {
  provider: StudioImageProvider
  workflow?: string
  model?: string
}

export interface FlowModelChoice {
  /** A 3D preset id; recorded on the material as `use`. */
  use?: string
  target_faces?: number
  texture_size?: 1024 | 2048 | 4096
  compress_textures?: boolean
}

export interface FlowVideoChoice {
  workflow?: string
  /** Seconds. */
  duration?: number
}

/** What the steps are asked for, picked on the first screen and the cards'
 *  settings. Kept in the flow so a rerun — and the reopened project — uses
 *  the same choice. Absent → the generator's defaults. Validation is the
 *  generator call's (`studio_assets::generator_call`), the same one the MCP
 *  tool goes through. */
export interface FlowOptions {
  image?: FlowImageChoice
  model?: FlowModelChoice
  video?: FlowVideoChoice
}

export interface StudioFlow {
  schema: 1
  prompt: string
  goal: FlowGoal
  /** A character goes through a T-pose and gets bones. */
  character: boolean
  /** The video step's prompt: motion, camera, an `Audio: …` line. */
  motion?: string
  camera?: FlowCamera
  options?: FlowOptions
  steps: Partial<Record<FlowStepId, FlowStepRecord>>
  created_at: string
}

export const DEFAULT_CAMERA: FlowCamera = { yaw: 0, pitch: 8, cam_dist: 6.2 }

/** Game-sized lift, the drawer's default too. */
const LIFT_3D = { target_faces: 10000, texture_size: 2048 } as const

/** The steps a goal takes, in order — the decided card order 그림 → 3D →
 *  장면 · 카메라 → 렌더 → 영상, with a T-pose before the lift and bones after
 *  it for a character (model-pick 2026-10-08: a T-pose rigs cleanly). */
export function planSteps(goal: FlowGoal, character: boolean): FlowStepId[] {
  const lift: FlowStepId[] = character
    ? ["image", "tpose", "model"]
    : ["image", "model"]
  switch (goal) {
    case "image":
      return ["image"]
    case "scene":
      return lift
    case "model":
      return character ? [...lift, "rig"] : lift
    case "video":
      return [
        ...lift,
        ...(character ? (["rig"] as FlowStepId[]) : []),
        "camera",
        "render",
        "video",
      ]
  }
}

export function newFlow(
  prompt: string,
  goal: FlowGoal,
  character: boolean,
  now = new Date(),
  image?: FlowImageChoice
): StudioFlow {
  return {
    schema: 1,
    prompt: prompt.trim(),
    goal,
    character,
    motion: defaultMotion(prompt, character),
    camera: { ...DEFAULT_CAMERA },
    ...(image ? { options: { image } } : {}),
    steps: {},
    created_at: now.toISOString(),
  }
}

/** One key per picture choice, for selects and comparisons. */
export function choiceKey(c: FlowImageChoice | StudioImageChoice): string {
  return `${c.provider}:${c.provider === "comfyui" ? (c.workflow ?? "") : (c.model ?? "")}`
}

/** The part of a choice the generator call takes. */
export function imageChoiceOf(
  c: FlowImageChoice | StudioImageChoice
): FlowImageChoice {
  return c.provider === "comfyui"
    ? { provider: "comfyui", ...(c.workflow ? { workflow: c.workflow } : {}) }
    : { provider: c.provider, ...(c.model ? { model: c.model } : {}) }
}

/** The 3D values a lift uses: the card's choice, else a character preset
 *  or the game-sized default. */
export function modelChoice(flow: StudioFlow): FlowModelChoice {
  return (
    flow.options?.model ??
    (flow.character ? { use: "mobile-character" } : { ...LIFT_3D })
  )
}

/** Replace one step's choice. */
export function withOption<K extends keyof FlowOptions>(
  flow: StudioFlow,
  key: K,
  value: FlowOptions[K] | undefined
): StudioFlow {
  const options = { ...flow.options }
  if (value === undefined) delete options[key]
  else options[key] = value
  return { ...flow, options }
}

/** A first motion prompt, editable on the video card. H3 wants the motion,
 *  the camera and the sound in one block. */
export function defaultMotion(prompt: string, character: boolean): string {
  const subject = prompt.trim().replace(/[.。]+$/, "")
  return character
    ? `${subject} walks toward the camera with a lively stride. Slow push-in camera. Audio: footsteps and a light, cheerful ambience.`
    : `${subject} turns slowly in soft studio light. Slow orbiting camera. Audio: calm room tone.`
}

/** `무엇을 만들까요?` → a folder name: ascii words from the prompt, else a
 *  dated `studio-…` name. */
export function projectNameFor(prompt: string, now = new Date()): string {
  const words = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
  if (words.length > 0) return words.join("-").slice(0, 40)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `studio-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** The material a step feeds on, by walking back through the plan. */
function latest(flow: StudioFlow, ...ids: FlowStepId[]): string | undefined {
  for (const id of ids) {
    const m = flow.steps[id]
    if (m?.status === "done" && m.material) return m.material
  }
  return undefined
}

/** The operation that runs a step, or `null` while its input is missing. */
export function stepOp(step: FlowStepId, flow: StudioFlow): StudioOp | null {
  const cam = flow.camera ?? DEFAULT_CAMERA
  switch (step) {
    case "image": {
      const choice = flow.options?.image
      return {
        op: "generate_asset",
        kind: "image",
        prompt: flow.prompt,
        id: projectNameFor(flow.prompt),
        ...(choice ? imageChoiceOf(choice) : {}),
      }
    }
    case "tpose": {
      const from = latest(flow, "image")
      return from ? { op: "generate_asset", kind: "tpose", from } : null
    }
    case "model": {
      const from = latest(flow, "tpose", "image")
      if (!from) return null
      return { op: "generate_asset", kind: "3d", from, ...modelChoice(flow) }
    }
    case "rig": {
      const from = latest(flow, "model")
      return from ? { op: "generate_asset", kind: "rig", from } : null
    }
    case "camera": {
      const from = latest(flow, "rig", "model")
      return from
        ? {
            op: "render_asset",
            from,
            mode: "still",
            yaw: cam.yaw,
            pitch: cam.pitch,
            cam_dist: cam.cam_dist,
          }
        : null
    }
    case "render": {
      const from = latest(flow, "rig", "model")
      if (!from) return null
      return {
        op: "render_asset",
        from,
        mode: flow.steps.rig?.status === "done" ? "walk" : "turntable",
        yaw: cam.yaw,
        pitch: cam.pitch,
        cam_dist: cam.cam_dist,
        keyframes: [1],
      }
    }
    case "video": {
      const from = flow.steps.render?.stills?.[0]
      const prompt = flow.motion?.trim()
      const v = flow.options?.video
      return from && prompt
        ? {
            op: "generate_asset",
            kind: "video",
            from,
            prompt,
            ...(v?.workflow ? { workflow: v.workflow } : {}),
            ...(v?.duration ? { duration: v.duration } : {}),
          }
        : null
    }
  }
}

/** What a finished operation leaves on the step record. */
export function recordOf(
  outcome: StudioOutcome,
  now = new Date()
): FlowStepRecord {
  const at = now.toISOString()
  if (!outcome.ok) return { status: "failed", note: outcome.note, at }
  const id = (v: unknown) =>
    v && typeof v === "object" && "id" in v
      ? String((v as { id: unknown }).id)
      : undefined
  // generate_asset → { asset }, render_asset → { video, keyframes }.
  const stills = Array.isArray(outcome.keyframes)
    ? outcome.keyframes.map(id).filter((s): s is string => Boolean(s))
    : undefined
  const material = id(outcome.asset) ?? id(outcome.video) ?? stills?.[0]
  return {
    status: "done",
    ...(material ? { material } : {}),
    ...(stills?.length ? { stills } : {}),
    at,
  }
}

/** The first step of the plan that has not succeeded. */
export function nextStep(flow: StudioFlow): FlowStepId | null {
  return (
    planSteps(flow.goal, flow.character).find(
      (s) => flow.steps[s]?.status !== "done"
    ) ?? null
  )
}

/** Running a step again makes everything after it stale. */
export function withoutStepsFrom(
  flow: StudioFlow,
  step: FlowStepId
): StudioFlow {
  const plan = planSteps(flow.goal, flow.character)
  const at = plan.indexOf(step)
  if (at < 0) return flow
  const steps = { ...flow.steps }
  for (const s of plan.slice(at)) delete steps[s]
  return { ...flow, steps }
}

/** A flow read back from disk, or `null` when it is not one. */
export function parseFlow(value: unknown): StudioFlow | null {
  if (!value || typeof value !== "object") return null
  const v = value as Partial<StudioFlow>
  if (
    v.schema !== 1 ||
    typeof v.prompt !== "string" ||
    !FLOW_GOALS.includes(v.goal as FlowGoal)
  )
    return null
  return {
    ...(v as StudioFlow),
    character: Boolean(v.character),
    steps: v.steps && typeof v.steps === "object" ? v.steps : {},
  }
}
