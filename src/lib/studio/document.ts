/**
 * The scene document the engine runs and the Studio edits — one file, one
 * schema: `outputs/game/content/<scene>.studio.json`.
 *
 * The editor understands a small core (container, assets, node transforms,
 * a few props) and preserves everything else byte-for-byte: `logic`, engine
 * specific props, grids, whatever an agent adds. That is the contract that
 * lets an agent extend the game without the editor rejecting the file.
 */

export type SceneAnchor = "top-left" | "center" | "bottom-center"

export interface SceneTransform {
  x: number
  y: number
  w: number
  h: number
  anchor: SceneAnchor
  z: number
}

export interface SceneNode {
  id: string
  /** Another node's id for relative placement; anything else means the
   *  container origin (`root` by convention). */
  parent: string
  /** `sprite`, `rect`, `text` are what the editor and the scaffolded engine
   *  know; other strings are kept and shown as plain boxes. */
  type: string
  transform: SceneTransform
  /** Engine-owned bag. The editor edits `visible`, `asset`, `text`, `size`,
   *  `color`, `interactive`, `onClick` and leaves the rest alone. */
  props: Record<string, unknown>
}

export interface SceneAsset {
  id: string
  /** Relative to the project's `assets/` directory. */
  file: string
  width: number
  height: number
  missing?: boolean
  [key: string]: unknown
}

export interface SceneDocument {
  container: { width: number; height: number }
  assets: SceneAsset[]
  nodes: SceneNode[]
  [key: string]: unknown
}

export interface SceneFile {
  schema: 1
  id: string
  name: string
  document: SceneDocument
  [key: string]: unknown
}

export type SceneCommand =
  | { type: "node.add"; node: SceneNode }
  | {
      type: "node.update"
      id: string
      transform?: Partial<SceneTransform>
      props?: Record<string, unknown>
    }
  | { type: "node.remove"; id: string }
  | { type: "node.reorder"; id: string; direction: "forward" | "backward" }
  | { type: "scene.update"; name?: string }
  /** `logic.actions[name] = steps` — what a click (`props.onClick`) runs. */
  | { type: "action.set"; name: string; steps: ActionStep[] }
  | { type: "action.remove"; name: string }

/** One step of a `logic.actions` entry: an engine op plus its arguments. */
export interface ActionStep {
  op: string
  [key: string]: unknown
}

export const MAX_NODES = 1000
export const MAX_ASSETS = 500
export const MAX_ACTION_STEPS = 100
const ID = /^[a-zA-Z0-9_-]{1,100}$/
export const ANCHORS: SceneAnchor[] = ["top-left", "center", "bottom-center"]
const COORD = 1_000_000

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${what}: expected an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, what: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${what}: expected text (1–${max} chars)`)
  return value
}
function id(value: unknown, what: string): string {
  const result = string(value, what)
  if (!ID.test(result))
    throw new Error(`${what}: ids use letters, digits, - and _ (max 100)`)
  return result
}
function number(
  value: unknown,
  what: string,
  min: number,
  max: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${what}: expected a number between ${min} and ${max}`)
  return value
}
function optionalNumber(
  value: unknown,
  fallback: number,
  what: string,
  min: number,
  max: number
): number {
  return value === undefined ? fallback : number(value, what, min, max)
}

export function parseTransform(value: unknown, what: string): SceneTransform {
  const t = object(value, what)
  const anchor = t.anchor === undefined ? "top-left" : t.anchor
  if (!ANCHORS.includes(anchor as SceneAnchor))
    throw new Error(`${what}.anchor: expected ${ANCHORS.join(", ")}`)
  return {
    x: number(t.x, `${what}.x`, -COORD, COORD),
    y: number(t.y, `${what}.y`, -COORD, COORD),
    w: number(t.w, `${what}.w`, 1, COORD),
    h: number(t.h, `${what}.h`, 1, COORD),
    anchor: anchor as SceneAnchor,
    z: optionalNumber(t.z, 0, `${what}.z`, -COORD, COORD),
  }
}

function parseAsset(value: unknown, index: number): SceneAsset {
  const what = `assets[${index}]`
  const a = object(value, what)
  const file = string(a.file, `${what}.file`, 500)
  if (file.startsWith("/") || file.split(/[\\/]/).includes(".."))
    throw new Error(`${what}.file: must be relative to assets/`)
  return {
    ...a,
    id: id(a.id, `${what}.id`),
    file,
    width: number(a.width, `${what}.width`, 1, 16384),
    height: number(a.height, `${what}.height`, 1, 16384),
    ...(a.missing === undefined ? {} : { missing: Boolean(a.missing) }),
  }
}

function parseNode(value: unknown, index: number): SceneNode {
  const what = `nodes[${index}]`
  const n = object(value, what)
  const props = n.props === undefined ? {} : object(n.props, `${what}.props`)
  for (const key of Object.keys(props)) {
    if (typeof props[key] === "function")
      throw new Error(`${what}.props.${key}: functions are not allowed`)
  }
  return {
    id: id(n.id, `${what}.id`),
    parent:
      n.parent === undefined ? "root" : string(n.parent, `${what}.parent`),
    type: string(n.type, `${what}.type`, 40),
    transform: parseTransform(n.transform, `${what}.transform`),
    props: structuredClone(props),
  }
}

/** Validate and normalize a scene file. Unknown top-level and document
 *  fields are preserved; core fields are checked and defaulted. */
export function parseScene(value: unknown): SceneFile {
  const raw = object(value, "scene")
  if (raw.schema !== undefined && raw.schema !== 1)
    throw new Error(`Unsupported scene schema ${String(raw.schema)}`)
  const sceneId = id(raw.id, "scene.id")
  const doc = object(raw.document, "scene.document")
  const container = object(doc.container, "scene.document.container")
  if (!Array.isArray(doc.nodes))
    throw new Error("scene.document.nodes: expected a list")
  if (doc.nodes.length > MAX_NODES)
    throw new Error(`A scene supports up to ${MAX_NODES} nodes`)
  const assetsRaw = doc.assets === undefined ? [] : doc.assets
  if (!Array.isArray(assetsRaw))
    throw new Error("scene.document.assets: expected a list")
  if (assetsRaw.length > MAX_ASSETS)
    throw new Error(`A scene supports up to ${MAX_ASSETS} assets`)

  const assets = assetsRaw.map(parseAsset)
  if (new Set(assets.map((a) => a.id)).size !== assets.length)
    throw new Error("Duplicate asset id")
  const nodes = doc.nodes.map(parseNode)
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length)
    throw new Error("Duplicate node id")

  const name = raw.name
  const restTop = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) => !["schema", "id", "name", "document"].includes(key)
    )
  )
  const restDoc = Object.fromEntries(
    Object.entries(doc).filter(
      ([key]) => !["container", "assets", "nodes"].includes(key)
    )
  )
  return {
    ...structuredClone(restTop),
    schema: 1,
    id: sceneId,
    name:
      typeof name === "string" && name.trim().length > 0
        ? name.slice(0, 200)
        : sceneId,
    document: {
      ...structuredClone(restDoc),
      container: {
        width: number(container.width, "container.width", 16, 16384),
        height: number(container.height, "container.height", 16, 16384),
      },
      assets,
      nodes,
    },
  }
}

/** Absolute top-left box of a node in container pixels, following the
 *  parent chain (cycle-safe: a loop falls back to the container origin). */
export function nodeRect(
  document: SceneDocument,
  node: SceneNode
): { x: number; y: number; w: number; h: number } {
  const byId = new Map(document.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const walk = (n: SceneNode): { x: number; y: number } => {
    const t = n.transform
    let x = t.x
    let y = t.y
    if (t.anchor === "bottom-center") {
      x -= t.w / 2
      y -= t.h
    } else if (t.anchor === "center") {
      x -= t.w / 2
      y -= t.h / 2
    }
    seen.add(n.id)
    const parent = byId.get(n.parent)
    if (parent && !seen.has(parent.id)) {
      const p = walk(parent)
      x += p.x
      y += p.y
    }
    return { x, y }
  }
  const { x, y } = walk(node)
  return { x, y, w: node.transform.w, h: node.transform.h }
}

export function isVisible(node: SceneNode): boolean {
  return node.props.visible !== false
}

const TRANSFORM_KEYS: (keyof SceneTransform)[] = [
  "x",
  "y",
  "w",
  "h",
  "anchor",
  "z",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseSteps(value: unknown): ActionStep[] {
  if (!Array.isArray(value) || value.length > MAX_ACTION_STEPS)
    throw new Error(`steps: expected a list of up to ${MAX_ACTION_STEPS}`)
  return value.map((raw, index) => {
    const step = object(raw, `steps[${index}]`)
    string(step.op, `steps[${index}].op`, 40)
    return structuredClone(step) as ActionStep
  })
}

/** Names and steps of `logic.actions`, tolerant of a missing or odd `logic`. */
export function sceneActions(scene: SceneFile): Record<string, ActionStep[]> {
  const logic = scene.logic
  if (!isRecord(logic) || !isRecord(logic.actions)) return {}
  const out: Record<string, ActionStep[]> = {}
  for (const [name, steps] of Object.entries(logic.actions))
    if (Array.isArray(steps)) out[name] = steps as ActionStep[]
  return out
}

/** Apply a batch atomically: any invalid command leaves the input untouched. */
export function applyCommands(scene: SceneFile, commands: unknown): SceneFile {
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.length > 200
  )
    throw new Error("Provide between 1 and 200 commands")
  const next = structuredClone(scene)
  const nodes = next.document.nodes
  for (const input of commands) {
    const command = object(input, "command")
    if (command.type === "scene.update") {
      if (command.name !== undefined) next.name = string(command.name, "name")
      continue
    }
    if (command.type === "node.add") {
      nodes.push(parseNode(command.node, nodes.length))
      continue
    }
    if (command.type === "action.set" || command.type === "action.remove") {
      const name = id(command.name, "action name")
      const logic = isRecord(next.logic) ? next.logic : {}
      const actions = isRecord(logic.actions) ? logic.actions : {}
      if (command.type === "action.remove") delete actions[name]
      else actions[name] = parseSteps(command.steps)
      logic.actions = actions
      next.logic = logic
      continue
    }
    const targetId = string(command.id, "command.id")
    const index = nodes.findIndex((n) => n.id === targetId)
    if (index < 0) throw new Error(`Node not found: ${targetId}`)
    const node = nodes[index]
    if (command.type === "node.update") {
      if (command.transform !== undefined) {
        const patch = object(command.transform, "transform")
        for (const key of Object.keys(patch)) {
          if (!TRANSFORM_KEYS.includes(key as keyof SceneTransform))
            throw new Error(`transform.${key}: unknown field`)
        }
        node.transform = parseTransform(
          { ...node.transform, ...patch },
          "transform"
        )
      }
      if (command.props !== undefined) {
        const patch = object(command.props, "props")
        for (const [key, value] of Object.entries(patch)) {
          if (typeof value === "function")
            throw new Error(`props.${key}: functions are not allowed`)
          node.props[key] = structuredClone(value)
        }
      }
    } else if (command.type === "node.remove") {
      const doomed = new Set([targetId])
      let grew = true
      while (grew) {
        grew = false
        for (const n of nodes) {
          if (!doomed.has(n.id) && doomed.has(n.parent)) {
            doomed.add(n.id)
            grew = true
          }
        }
      }
      next.document.nodes = nodes.filter((n) => !doomed.has(n.id))
    } else if (command.type === "node.reorder") {
      const zs = nodes.map((n) => n.transform.z)
      if (command.direction === "forward")
        node.transform.z = Math.max(...zs) + 1
      else if (command.direction === "backward")
        node.transform.z = Math.min(...zs) - 1
      else throw new Error("direction: expected forward or backward")
    } else throw new Error(`Unknown command: ${String(command.type)}`)
  }
  return parseScene(next)
}

export function createNode(
  type: "rect" | "text" | "sprite",
  id: string
): SceneNode {
  const base = { id, parent: "root", type }
  if (type === "text")
    return {
      ...base,
      transform: { x: 90, y: 200, w: 900, h: 120, anchor: "top-left", z: 10 },
      props: { text: id, size: 48, color: "#f2efe6", align: "left" },
    }
  if (type === "sprite")
    return {
      ...base,
      transform: {
        x: 540,
        y: 960,
        w: 120,
        h: 180,
        anchor: "bottom-center",
        z: 20,
      },
      props: { asset: null, placeholder: "#ffb347", interactive: false },
    }
  return {
    ...base,
    transform: { x: 100, y: 100, w: 300, h: 200, anchor: "top-left", z: 1 },
    props: { color: "#8b9cf7" },
  }
}

/** A new scene as the scaffold writes it, with the ids an engine expects. */
export function createStarterScene(sceneId: string, name = sceneId): SceneFile {
  return {
    schema: 1,
    id: sceneId,
    name,
    document: {
      container: { width: 1080, height: 1920 },
      assets: [],
      nodes: [
        {
          id: "bg",
          parent: "root",
          type: "rect",
          transform: { x: 0, y: 0, w: 1080, h: 1920, anchor: "top-left", z: 0 },
          props: { color: "#1b1b2f", interactive: false },
        },
        {
          id: "title",
          parent: "root",
          type: "text",
          transform: {
            x: 90,
            y: 200,
            w: 900,
            h: 160,
            anchor: "top-left",
            z: 10,
          },
          props: { text: name, size: 96, color: "#f2efe6", align: "center" },
        },
      ],
    },
    logic: { actions: {} },
  }
}

/**
 * The first Studio prototype saved `{ format: "codeg-studio-project",
 * document: { schemaVersion: 1, nodes: [...rectangle/ellipse/image] } }` with
 * images under `content/blobs/`. Convert it so an old file still opens; the
 * next save writes the current schema.
 */
export function fromLegacyProjectFile(input: unknown): SceneFile | null {
  const raw = input as Record<string, unknown> | null
  if (!raw || raw.format !== "codeg-studio-project") return null
  const doc = object(raw.document, "document")
  const legacyAssets = (Array.isArray(doc.assets) ? doc.assets : []) as Array<
    Record<string, unknown>
  >
  const ext: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  }
  // Prototype images lived under content/blobs/, outside assets/. They are
  // declared as missing so the engine draws placeholders; copy the file into
  // assets/ and clear the flag to restore it.
  const assets: SceneAsset[] = legacyAssets.map((a) => ({
    id: String(a.id),
    file: `legacy/${String(a.id)}.${ext[String(a.mime)] ?? "png"}`,
    width: Number(a.width) || 1,
    height: Number(a.height) || 1,
    missing: true,
  }))
  const legacyNodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as Array<
    Record<string, unknown>
  >
  const actions: Record<string, unknown[]> = {}
  const nodes: SceneNode[] = [
    {
      id: "background",
      parent: "root",
      type: "rect",
      transform: {
        x: 0,
        y: 0,
        w: Number(doc.width) || 960,
        h: Number(doc.height) || 540,
        anchor: "top-left",
        z: -1,
      },
      props: {
        color: typeof doc.background === "string" ? doc.background : "#161d2d",
      },
    },
    ...legacyNodes.map((n, index): SceneNode => {
      const props: Record<string, unknown> = { visible: n.visible !== false }
      if (n.kind === "image") props.asset = n.assetId
      else {
        props.color = n.color
        if (n.kind === "ellipse") props.shape = "ellipse"
      }
      if (typeof n.toggleTarget === "string" && n.toggleTarget) {
        const action = `toggle_${String(n.id)}`
        actions[action] = [{ op: "toggle", id: n.toggleTarget }]
        props.interactive = true
        props.onClick = action
      }
      return {
        id: String(n.id),
        parent: "root",
        type: n.kind === "image" ? "sprite" : "rect",
        transform: {
          x: Number(n.x) || 0,
          y: Number(n.y) || 0,
          w: Number(n.width) || 1,
          h: Number(n.height) || 1,
          anchor: "top-left",
          z: index,
        },
        props,
      }
    }),
  ]
  return parseScene({
    schema: 1,
    id: typeof doc.id === "string" ? doc.id : "main",
    name: typeof doc.name === "string" ? doc.name : "main",
    document: {
      container: {
        width: Number(doc.width) || 960,
        height: Number(doc.height) || 540,
      },
      assets,
      nodes,
    },
    logic: { actions },
  })
}
