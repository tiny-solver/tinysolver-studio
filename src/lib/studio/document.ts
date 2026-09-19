/** Engine-independent authoring data. Keep renderer objects out of this schema. */
export interface StudioAsset {
  id: string
  name: string
  mime: "image/png" | "image/jpeg" | "image/webp"
  width: number
  height: number
  size: number
}

export interface StudioNode {
  id: string
  name: string
  kind: "rectangle" | "ellipse" | "image"
  x: number
  y: number
  width: number
  height: number
  color: string
  visible: boolean
  assetId?: string
  toggleTarget?: string
}

export interface StudioDocument {
  schemaVersion: 1
  id: string
  name: string
  width: number
  height: number
  background: string
  assets: StudioAsset[]
  nodes: StudioNode[]
}

export type StudioCommand =
  | { type: "node.add"; node: StudioNode }
  | {
      type: "node.update"
      id: string
      patch: Partial<Omit<StudioNode, "id" | "kind" | "assetId">>
    }
  | { type: "node.remove"; id: string }
  | { type: "node.reorder"; id: string; direction: "forward" | "backward" }
  | {
      type: "document.update"
      patch: Partial<Pick<StudioDocument, "name" | "background">>
    }

export const MAX_ASSET_BYTES = 10 * 1024 * 1024
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024
const ID = /^[a-zA-Z0-9_-]{1,100}$/
const COLOR = /^#[0-9a-fA-F]{6}$/
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object")
  return value as Record<string, unknown>
}
function string(value: unknown, max = 120): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error("Invalid text value")
  return value
}
function id(value: unknown): string {
  const result = string(value)
  if (!ID.test(result)) throw new Error("Invalid identifier")
  return result
}
function number(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Expected a number between ${min} and ${max}`)
  return value
}
function color(value: unknown): string {
  const result = string(value)
  if (!COLOR.test(result)) throw new Error("Expected a #RRGGBB color")
  return result
}

export function parseDocument(value: unknown): StudioDocument {
  const raw = object(value)
  if (raw.schemaVersion !== 1) throw new Error("Unsupported document version")
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 200)
    throw new Error("A scene supports up to 200 nodes")
  if (!Array.isArray(raw.assets) || raw.assets.length > 40)
    throw new Error("A scene supports up to 40 assets")
  const assets: StudioAsset[] = raw.assets.map((value) => {
    const a = object(value)
    if (
      a.mime !== "image/png" &&
      a.mime !== "image/jpeg" &&
      a.mime !== "image/webp"
    )
      throw new Error("Unsupported image format")
    return {
      id: id(a.id),
      name: string(a.name, 255),
      mime: a.mime,
      width: number(a.width, 1, 8192),
      height: number(a.height, 1, 8192),
      size: number(a.size, 1, MAX_ASSET_BYTES),
    }
  })
  if (new Set(assets.map((a) => a.id)).size !== assets.length)
    throw new Error("Duplicate asset ID")
  if (assets.reduce((sum, a) => sum + a.size, 0) > 20 * 1024 * 1024)
    throw new Error("Scene images exceed 20 MB")
  const nodes: StudioNode[] = raw.nodes.map((value) => {
    const n = object(value)
    if (n.kind !== "rectangle" && n.kind !== "ellipse" && n.kind !== "image")
      throw new Error("Unsupported node kind")
    if (typeof n.visible !== "boolean") throw new Error("Invalid visibility")
    const node: StudioNode = {
      id: id(n.id),
      name: string(n.name),
      kind: n.kind,
      x: number(n.x, -8192, 8192),
      y: number(n.y, -8192, 8192),
      width: number(n.width, 1, 8192),
      height: number(n.height, 1, 8192),
      color: color(n.color),
      visible: n.visible,
    }
    if (n.kind === "image") {
      node.assetId = id(n.assetId)
      if (!assets.some((a) => a.id === node.assetId))
        throw new Error("Missing image asset")
    }
    if (n.toggleTarget !== undefined && n.toggleTarget !== "")
      node.toggleTarget = id(n.toggleTarget)
    return node
  })
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length)
    throw new Error("Duplicate node ID")
  for (const node of nodes) {
    if (node.toggleTarget && !nodes.some((n) => n.id === node.toggleTarget))
      throw new Error("Missing interaction target")
  }
  return {
    schemaVersion: 1,
    id: id(raw.id),
    name: string(raw.name),
    width: number(raw.width, 100, 4096),
    height: number(raw.height, 100, 4096),
    background: color(raw.background),
    assets,
    nodes,
  }
}

/** All UI and imported command edits cross the same validation/transaction boundary. */
export function applyCommands(
  document: StudioDocument,
  commands: unknown
): StudioDocument {
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.length > 100
  )
    throw new Error("Provide between 1 and 100 commands")
  let next = structuredClone(document)
  for (const input of commands) {
    const command = object(input)
    if (command.type === "document.update") {
      const patch = object(command.patch)
      const allowed = ["name", "background"]
      if (Object.keys(patch).some((key) => !allowed.includes(key)))
        throw new Error("Unsupported document field")
      next = { ...next, ...patch } as StudioDocument
    } else if (command.type === "node.add") {
      next.nodes.push(command.node as StudioNode)
    } else {
      const index = next.nodes.findIndex((n) => n.id === command.id)
      if (index < 0) throw new Error("Node not found")
      if (command.type === "node.update") {
        const patch = object(command.patch)
        const allowed = [
          "name",
          "x",
          "y",
          "width",
          "height",
          "color",
          "visible",
          "toggleTarget",
        ]
        if (Object.keys(patch).some((key) => !allowed.includes(key)))
          throw new Error("Unsupported node field")
        next.nodes[index] = { ...next.nodes[index], ...patch }
      } else if (command.type === "node.remove") {
        next.nodes.splice(index, 1)
        next.nodes = next.nodes.map((node) =>
          node.toggleTarget === command.id
            ? { ...node, toggleTarget: undefined }
            : node
        )
      } else if (command.type === "node.reorder") {
        if (command.direction !== "forward" && command.direction !== "backward")
          throw new Error("Invalid layer direction")
        const target = Math.max(
          0,
          Math.min(
            next.nodes.length - 1,
            index + (command.direction === "forward" ? 1 : -1)
          )
        )
        const [node] = next.nodes.splice(index, 1)
        next.nodes.splice(target, 0, node)
      } else throw new Error("Unknown command")
    }
  }
  return parseDocument(next)
}

export function createNode(
  kind: "rectangle" | "ellipse",
  name: string
): StudioNode {
  return {
    id: crypto.randomUUID(),
    name,
    kind,
    x: 360,
    y: 210,
    width: 180,
    height: 120,
    color: "#8b9cf7",
    visible: true,
  }
}

export function createDemoDocument(): StudioDocument {
  return {
    schemaVersion: 1,
    id: "first-scene",
    name: "Signal lab",
    width: 960,
    height: 540,
    background: "#161d2d",
    assets: [],
    nodes: [
      {
        id: "panel",
        name: "Panel",
        kind: "rectangle",
        x: 190,
        y: 100,
        width: 580,
        height: 340,
        color: "#243149",
        visible: true,
      },
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
        name: "Switch · click in preview",
        kind: "rectangle",
        x: 365,
        y: 320,
        width: 230,
        height: 64,
        color: "#8b9cf7",
        visible: true,
        toggleTarget: "signal",
      },
    ],
  }
}
