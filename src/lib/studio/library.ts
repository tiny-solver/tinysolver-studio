/**
 * The 3D library (decide 3d-gallery-graph): every project's 3D materials in
 * one place, side by side, and how each one was made as a node graph.
 *
 * Nothing new is recorded for it. The graph is read from what is already
 * there: a material's `source` (workflow · prompt · seed · `from`, followed
 * back through the register) and the flow run records under `runs/` whose
 * nodes produced it. Port colours are the kind of data on the wire, guessed
 * from the key and the value (`prompt` → TEXT, `.png` → IMAGE, a registered
 * GLB with bones → RIGGED, with clips → ANIM).
 */

import { getContentPreview, studioRun } from "@/lib/api"
import {
  listProjects,
  type NodeRecord,
  type RunRecord,
} from "@/lib/studio/flows"
import { previewBase } from "@/lib/studio/game-url"
import type { StudioAsset, StudioAssetList } from "@/lib/types"

export type Role = "scene" | "character" | "prop"

export interface LibraryProject {
  name: string
  root: string
  /** `<preview origin>/<project>/` — serves the project folder. */
  base: string | null
  assetsDir: string
  assets: StudioAsset[]
  error?: string
}

export interface LibraryItem {
  /** `<project name>:<material id>` — what the page's query names. */
  key: string
  project: LibraryProject
  asset: StudioAsset
  role: Role
}

export interface Clip {
  name: string
  seconds: number
}

/** The clips the register read from the GLB. */
export const clipsOf = (asset: StudioAsset): Clip[] => asset.clips ?? []

/** Scene · character · prop: the register's own `role` when it says one of
 *  those, else a rigged model is a character and anything else a prop. */
export function roleOf(asset: StudioAsset): Role {
  if (asset.role) return asset.role
  return (asset.bones ?? 0) > 0 ? "character" : "prop"
}

export const itemKey = (project: string, id: string) => `${project}:${id}`

/** The projects to look in: the server's (server mode) or the one given. */
export async function loadLibrary(
  fallbackRoot: string | null
): Promise<LibraryProject[]> {
  const listed = await listProjects()
  const roots =
    listed?.projects.map((p) => ({ name: p.name, root: p.path })) ??
    (fallbackRoot
      ? [
          {
            name: fallbackRoot.split(/[\\/]/).pop() || "project",
            root: fallbackRoot,
          },
        ]
      : [])
  return Promise.all(
    roots.map(async ({ name, root }): Promise<LibraryProject> => {
      const [list, base] = await Promise.all([
        studioRun<StudioAssetList>(root, { op: "list_assets" } as never).catch(
          (e) => ({ ok: false, note: String(e) }) as unknown as StudioAssetList
        ),
        getContentPreview(root)
          .then((info) => `${previewBase(info)}/`)
          .catch(() => null),
      ])
      return {
        name,
        root,
        base,
        assetsDir: list.assets_dir ?? "assets",
        assets: list.ok ? (list.assets ?? []) : [],
        error: list.ok ? undefined : (list.note ?? "list_assets failed"),
      }
    })
  )
}

/** The 3D materials of the projects, newest first. */
export function modelItems(projects: LibraryProject[]): LibraryItem[] {
  return projects
    .flatMap((project) =>
      project.assets
        .filter((a) => a.kind === "model" || /\.(glb|gltf)$/i.test(a.file))
        .map((asset) => ({
          key: itemKey(project.name, asset.id),
          project,
          asset,
          role: roleOf(asset),
        }))
    )
    .sort((a, b) =>
      (b.asset.added_at ?? "").localeCompare(a.asset.added_at ?? "")
    )
}

/** A material's file as a URL the browser loads. */
export function fileUrl(project: LibraryProject, file: string): string | null {
  return project.base ? `${project.base}${project.assetsDir}/${file}` : null
}

/** A project-relative path (a run's picture) as a URL. */
export function projectUrl(
  project: LibraryProject,
  path: string
): string | null {
  return project.base ? `${project.base}${path.replace(/^\/+/, "")}` : null
}

/** The side-by-side viewer for some models, served from the first one's
 *  project (the viewer page is the same in every project). */
export function compareUrl(
  items: LibraryItem[],
  opts: { thumb?: boolean } = {}
): string | null {
  const base = items.find((i) => i.project.base)?.project.base
  if (!base) return null
  const q = new URLSearchParams()
  for (const it of items) {
    const url = fileUrl(it.project, it.asset.file)
    if (!url) continue
    q.append("src", new URL(url, location.href).href)
    q.append("label", it.asset.id)
  }
  if (opts.thumb) q.set("thumb", "1")
  return `${base}__codeg/viewer/compare.html?${q.toString()}`
}

// ─── The making graph ───

export type PortType =
  | "TEXT"
  | "IMAGE"
  | "MESH"
  | "RIGGED"
  | "LIMBS"
  | "ANIM"
  | "VIDEO"
  | "REPORT"
  | "DATA"

export const PORT_TYPES: PortType[] = [
  "TEXT",
  "IMAGE",
  "MESH",
  "RIGGED",
  "LIMBS",
  "ANIM",
  "VIDEO",
  "REPORT",
  "DATA",
]

export interface Port {
  /** `<node id>.<in|out>.<key>` */
  id: string
  key: string
  type: PortType
  /** What is on it, shortened for the card. */
  text: string
  /** The raw value — wires join an output to an input holding the same. */
  value: unknown
}

export interface GraphNode {
  id: string
  title: string
  /** Who · machine · model. */
  where: string
  status: "done" | "failed" | "running" | "waiting" | "skipped"
  ms?: number
  costUsd?: number | null
  ins: Port[]
  outs: Port[]
  settings: [string, string][]
  /** Project-relative pictures, or a material file (assets-relative). */
  thumbs: { path: string; material?: boolean }[]
  notes: string[]
}

export interface GraphEdge {
  from: string
  to: string
  type: PortType
}

export interface Graph {
  /** Where it was read from: `chain` (the register) or `<flow>/<run>`. */
  origin: string
  label: string
  status: GraphNode["status"]
  nodes: GraphNode[]
  edges: GraphEdge[]
  ms: number
  costUsd: number
}

export interface MakingGraph {
  main: Graph
  /** Other tries of the same flow that failed — drawn dimmed below. */
  failed: Graph[]
}

const PICTURE = /\.(png|jpe?g|webp|gif)$/i
const MODEL = /\.(glb|gltf)$/i
const MOVIE = /\.(mp4|webm|mov)$/i

const KEY_TYPES: [RegExp, PortType][] = [
  [/^(prompt|text|subject|ask|want)$/i, "TEXT"],
  [/^(limbs?|chains?)$/i, "LIMBS"],
  [/^(rig|rigged|skeleton)$/i, "RIGGED"],
  [/^(anim|animated|clips?)$/i, "ANIM"],
  [/^(mesh|model)$/i, "MESH"],
  [/^(image|picture|source_image|png)$/i, "IMAGE"],
  [/^(video|clip_video|movie)$/i, "VIDEO"],
  [/^(report|check|checks|score|verdict)$/i, "REPORT"],
]

/** Keys whose pictures are shown on the card, not wired. */
const THUMB_KEYS = /^(preview|previews|thumb|thumbs|frames)$/i
/** Keys folded into the settings table. */
const SETTINGS_KEYS = /^(params|settings|options)$/i
/** Output keys that are plumbing, not results. */
const SKIP_OUT = /^(ok|note|exists|check)$/

/** The type of the data a GLB is: a registered one says by its stats. */
function modelType(path: string, byFile: Map<string, StudioAsset>): PortType {
  const hit = [...byFile.entries()].find(([f]) => path.endsWith(f))?.[1]
  if (hit && (hit.animations ?? 0) > 0) return "ANIM"
  if (hit && (hit.bones ?? 0) > 0) return "RIGGED"
  return "MESH"
}

export function portType(
  key: string,
  value: unknown,
  byFile: Map<string, StudioAsset> = new Map()
): PortType {
  for (const [re, type] of KEY_TYPES) if (re.test(key)) return type
  if (typeof value === "string") {
    if (PICTURE.test(value) || value.startsWith("data:image/")) return "IMAGE"
    if (MODEL.test(value)) return modelType(value, byFile)
    if (MOVIE.test(value)) return "VIDEO"
    return "TEXT"
  }
  if (value && typeof value === "object" && "file" in value) {
    const file = String((value as { file: unknown }).file)
    return portType(key === "asset" ? "" : key, file, byFile)
  }
  return "DATA"
}

function short(value: unknown, max = 90): string {
  let text: string
  if (typeof value === "string")
    text = value.startsWith("data:") ? `${value.slice(0, 22)}…` : value
  else if (value && typeof value === "object" && "file" in value)
    text = String((value as { file: unknown }).file)
  else if (value && typeof value === "object" && !Array.isArray(value))
    // `{ handL: 8, footL: 5 }` → `handL 8 · footL 5`
    text = Object.entries(value)
      .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" · ")
  else text = JSON.stringify(value) ?? ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const isScalar = (v: unknown) =>
  v === null || ["number", "boolean"].includes(typeof v)

const isFileLike = (v: unknown) =>
  typeof v === "string" &&
  (PICTURE.test(v) || MODEL.test(v) || MOVIE.test(v) || v.startsWith("data:"))

function picturesIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (PICTURE.test(value) && !value.includes("://") && !out.includes(value))
      out.push(value)
  } else if (Array.isArray(value)) value.forEach((v) => picturesIn(v, out))
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => picturesIn(v, out))
  return out
}

/** One run node as a card: input split into wired ports and settings,
 *  output into ports, pictures onto the card. */
export function nodeFromRecord(
  rec: NodeRecord,
  title: string | undefined,
  byFile: Map<string, StudioAsset>
): GraphNode {
  const ins: Port[] = []
  const outs: Port[] = []
  const settings: [string, string][] = []
  const thumbs: GraphNode["thumbs"] = []
  const input = rec.input
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SETTINGS_KEYS.test(k) && v && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v as Record<string, unknown>))
          settings.push([sk, short(sv, 40)])
      } else if (
        KEY_TYPES.some(([re]) => re.test(k)) ||
        isFileLike(v) ||
        (v && typeof v === "object")
      ) {
        ins.push({
          id: `${rec.key}.in.${k}`,
          key: k,
          type: portType(k, v, byFile),
          text: short(v),
          value: v,
        })
      } else if (isScalar(v) || typeof v === "string") {
        settings.push([k, short(v, 40)])
      }
    }
  } else if (input != null) {
    ins.push({
      id: `${rec.key}.in.input`,
      key: "input",
      type: portType("input", input, byFile),
      text: short(input),
      value: input,
    })
  }
  const output = rec.output
  if (output && typeof output === "object" && !Array.isArray(output)) {
    for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
      if (SKIP_OUT.test(k)) continue
      if (THUMB_KEYS.test(k)) {
        picturesIn(v).forEach((path) => thumbs.push({ path }))
        continue
      }
      outs.push({
        id: `${rec.key}.out.${k}`,
        key: k,
        type: portType(k, v, byFile),
        text: short(v),
        value: v,
      })
    }
  } else if (output != null && output !== "") {
    outs.push({
      id: `${rec.key}.out.output`,
      key: "output",
      type: portType("output", output, byFile),
      text: short(output),
      value: output,
    })
  }
  for (const p of outs) {
    if (p.type === "IMAGE")
      picturesIn(p.value).forEach((path) => thumbs.push({ path }))
    const file =
      typeof p.value === "string"
        ? p.value
        : p.value && typeof p.value === "object" && "file" in p.value
          ? String((p.value as { file: unknown }).file)
          : ""
    const asset = [...byFile.values()].find(
      (a) => file && file.endsWith(a.file)
    )
    if (asset && asset.kind === "model")
      thumbs.push({ path: asset.file, material: true })
  }
  const status = rec.status
  return {
    id: rec.key,
    title: title || rec.node,
    where: rec.who ?? rec.kind,
    status,
    ms: rec.ms,
    costUsd: rec.cost_usd,
    ins,
    outs,
    settings,
    thumbs,
    notes: [...(rec.log ?? []), ...(rec.note ? [rec.note] : [])],
  }
}

const same = (a: unknown, b: unknown) =>
  a === b || (typeof a === "object" && JSON.stringify(a) === JSON.stringify(b))

/** Join every input to the nearest earlier output carrying the same value;
 *  failing that, to an earlier node its definition names (`${id.output…}`). */
export function wire(
  nodes: GraphNode[],
  defs: Map<string, unknown> = new Map()
) {
  const edges: GraphEdge[] = []
  nodes.forEach((node, i) => {
    const earlier = nodes.slice(0, i).reverse()
    const linked = new Set<string>()
    for (const port of node.ins) {
      for (const src of earlier) {
        const out = src.outs.find((o) => same(o.value, port.value))
        if (out) {
          edges.push({ from: out.id, to: port.id, type: out.type })
          linked.add(src.id)
          break
        }
      }
    }
    const def = JSON.stringify(defs.get(node.id) ?? "")
    for (const m of def.matchAll(/\$\{([A-Za-z0-9_-]+)\.output/g)) {
      const src = nodes.find((n) => n.id === m[1])
      if (!src || linked.has(src.id) || !src.outs[0]) continue
      const into =
        node.ins.find((p) => p.type === src.outs[0].type) ?? node.ins[0]
      if (!into) continue
      edges.push({ from: src.outs[0].id, to: into.id, type: src.outs[0].type })
      linked.add(src.id)
    }
  })
  return edges
}

const CONTAINERS = new Set(["seq", "parallel", "each", "if", "repeat"])

interface FlowStep {
  id: string
  note?: string
  steps?: FlowStep[]
  then?: FlowStep[]
  else?: FlowStep[]
}

function stepNotes(
  steps: FlowStep[] | undefined,
  out = new Map<string, string>()
) {
  for (const s of steps ?? []) {
    if (s.note) out.set(s.id, s.note)
    stepNotes(s.steps, out)
    stepNotes(s.then, out)
    stepNotes(s.else, out)
  }
  return out
}

/** A run as a graph: its leaf nodes as cards, wired by value. */
export function graphFromRun(
  run: RunRecord & { flow_doc?: { steps?: FlowStep[] } },
  byFile: Map<string, StudioAsset>
): Graph {
  const notes = stepNotes(run.flow_doc?.steps)
  const leaves = run.nodes.filter((n) => !CONTAINERS.has(n.kind))
  const nodes = leaves.map((n) => nodeFromRecord(n, notes.get(n.node), byFile))
  const defs = new Map(
    leaves.map((n) => [n.key, (n as NodeRecord & { def?: unknown }).def])
  )
  return {
    origin: `${run.flow}/${run.id}`,
    label: run.label || run.want?.text || run.id,
    status: run.status,
    nodes,
    edges: wire(nodes, defs),
    ms: run.ms,
    costUsd: run.cost_usd,
  }
}

/** The material and what it was made from, oldest first, by `source.from`. */
export function chainOf(
  asset: StudioAsset,
  register: StudioAsset[]
): StudioAsset[] {
  const byId = new Map(register.map((a) => [a.id, a]))
  const chain: StudioAsset[] = [asset]
  const seen = new Set([asset.id])
  let at = asset
  while (
    at.source?.from &&
    byId.has(at.source.from) &&
    !seen.has(at.source.from)
  ) {
    at = byId.get(at.source.from)!
    seen.add(at.id)
    chain.unshift(at)
  }
  return chain
}

/** One material as the node that made it. */
export function nodeFromMaterial(
  asset: StudioAsset,
  byFile: Map<string, StudioAsset>,
  parent?: StudioAsset
): GraphNode {
  const src = asset.source ?? {}
  const ins: Port[] = []
  if (typeof src.prompt === "string" && src.prompt)
    ins.push({
      id: `${asset.id}.in.prompt`,
      key: "prompt",
      type: "TEXT",
      text: short(src.prompt),
      value: src.prompt,
    })
  if (parent)
    ins.push({
      id: `${asset.id}.in.from`,
      key: "from",
      type: portType("", parent.file, byFile),
      text: parent.id,
      value: parent.file,
    })
  const settings: [string, string][] = []
  if (src.workflow) settings.push(["workflow", src.workflow])
  if (src.model) settings.push(["model", src.model])
  if (src.seed != null) settings.push(["seed", String(src.seed)])
  for (const [k, v] of Object.entries(src.params ?? {}))
    settings.push([k, short(v, 40)])
  if (src.url && !src.workflow) settings.push(["url", short(src.url, 40)])
  const facts = [
    asset.triangles != null ? `${asset.triangles.toLocaleString()} tris` : "",
    asset.bones ? `${asset.bones} bones` : "",
    clipsOf(asset)
      .map((c) => c.name)
      .join(" · "),
  ].filter(Boolean)
  return {
    id: asset.id,
    title: asset.id,
    where: [src.provider, src.kind].filter(Boolean).join(" · ") || "import",
    status: "done",
    ins,
    outs: [
      {
        id: `${asset.id}.out.file`,
        key: "file",
        type: portType("", asset.file, byFile),
        text: [asset.file, ...facts].join(" · "),
        value: asset.file,
      },
    ],
    settings,
    thumbs: [{ path: asset.file, material: true }],
    notes: [],
  }
}

export function graphFromChain(
  asset: StudioAsset,
  register: StudioAsset[]
): Graph {
  const byFile = new Map(register.map((a) => [a.file, a]))
  const chain = chainOf(asset, register)
  const nodes = chain.map((a, i) => nodeFromMaterial(a, byFile, chain[i - 1]))
  return {
    origin: "chain",
    label: asset.id,
    status: "done",
    nodes,
    edges: wire(nodes),
    ms: 0,
    costUsd: 0,
  }
}

/** Whether a run's nodes name the material's file. */
export function runMade(run: RunRecord, asset: StudioAsset): boolean {
  return run.nodes.some((n) =>
    JSON.stringify(n.output ?? "").includes(asset.file)
  )
}

/**
 * How a material was made: the run that names its file when there is one
 * (with the flow's other failed tries beside it), else its `source` chain.
 */
export function makingGraph(
  asset: StudioAsset,
  register: StudioAsset[],
  runs: RunRecord[]
): MakingGraph {
  const byFile = new Map(register.map((a) => [a.file, a]))
  // A finished run first; a material only a failed try left behind is
  // shown with that try.
  const made = runs
    .filter((r) => runMade(r, asset))
    .sort(
      (a, b) =>
        Number(a.status === "failed") - Number(b.status === "failed") ||
        b.started_at.localeCompare(a.started_at)
    )[0]
  if (!made) return { main: graphFromChain(asset, register), failed: [] }
  const failed = runs
    .filter(
      (r) => r.flow === made.flow && r.id !== made.id && r.status === "failed"
    )
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((r) => graphFromRun(r, byFile))
  return { main: graphFromRun(made, byFile), failed }
}

/** Columns for the canvas: each node one right of the furthest node that
 *  feeds it. */
export function depths(graph: Graph): Map<string, number> {
  const owner = new Map<string, string>()
  for (const n of graph.nodes)
    for (const p of [...n.ins, ...n.outs]) owner.set(p.id, n.id)
  const depth = new Map<string, number>()
  for (const n of graph.nodes) {
    const feeds = graph.edges
      .filter((e) => owner.get(e.to) === n.id)
      .map((e) => depth.get(owner.get(e.from) ?? "") ?? -1)
    depth.set(n.id, feeds.length ? Math.max(...feeds) + 1 : 0)
  }
  return depth
}
