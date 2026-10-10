import type { StudioOutcome } from "@/lib/types"

/**
 * A film set (`outputs/film/sets/<id>.set.json`, decide fs3-truth A): the 3D
 * stage — floor, lights, props, actors, cameras with paths — that the 3D set
 * view, the agents' `studio_*_set` tools and the Blender render share.
 *
 * The rules live in one place, `src-tauri/src/studio_set.rs`: the editor
 * never edits the file itself, it sends set commands through `studio_run`
 * and shows what comes back, the same path an agent's batch takes. This
 * module only mirrors the shapes, the time rule (for the timeline) and the
 * commands the editor's fields make.
 */

export type Vec3 = [number, number, number]
export type SetKind = "prop" | "actor" | "light" | "camera"
export type Ease = "smooth" | "linear"

export interface SetKey {
  t: number
  position: Vec3
  /** Cameras. */
  target?: Vec3
  roll?: number
  /** Actors. */
  yaw?: number
}

export interface SetModelItem {
  id: string
  name?: string
  /** A 3D model material id from the drawer. */
  asset: string
  position: Vec3
  rotation: Vec3
  height?: number
  scale?: number
}

export interface SetActor extends SetModelItem {
  motion: "still" | "walk"
  ease: Ease
  keys?: SetKey[]
}

export interface SetLight {
  id: string
  name?: string
  type: "sun" | "point" | "spot" | "area"
  position: Vec3
  target: Vec3
  color: string
  power: number
  size?: number
}

export interface SetCamera {
  id: string
  name?: string
  lens: number
  ease: Ease
  keys: SetKey[]
}

export interface FilmSet {
  schema: 1
  id: string
  name: string
  fps: number
  duration: number
  frame: { width: number; height: number }
  stage: {
    floor: { size: number; color: string } | null
    background: string
    ambient: number
  }
  props: SetModelItem[]
  actors: SetActor[]
  lights: SetLight[]
  cameras: SetCamera[]
  [key: string]: unknown
}

export type SetItem = SetModelItem | SetActor | SetLight | SetCamera

/** `read_set` · `create_set` · `apply_set_commands`. */
export interface SetOutcome extends StudioOutcome {
  set: string
  path: string
  file: FilmSet
  issues: string[]
  /** Material id → file under the assets folder. */
  models: Record<string, string>
  assets_dir: string
}

export interface SetSummary {
  id: string
  name?: string
  duration?: number
  cameras?: string[]
  error?: string
}

export const SET_LISTS = {
  prop: "props",
  actor: "actors",
  light: "lights",
  camera: "cameras",
} as const

/** Every item with its kind, in list order. */
export function setItems(set: FilmSet): { kind: SetKind; item: SetItem }[] {
  return (Object.keys(SET_LISTS) as SetKind[]).flatMap((kind) =>
    (set[SET_LISTS[kind]] as SetItem[]).map((item) => ({ kind, item }))
  )
}

export function findItem(
  set: FilmSet,
  id: string | null
): { kind: SetKind; item: SetItem } | null {
  if (!id) return null
  return setItems(set).find((e) => e.item.id === id) ?? null
}

/** A camera's or actor's values at `t` — `studio_set::sample`. */
export function sampleKeys(
  item: { keys?: SetKey[]; ease?: Ease; rotation?: Vec3 },
  t: number
): { position: Vec3; target?: Vec3; roll?: number; yaw: number } | null {
  const ks = item.keys ?? []
  if (ks.length === 0) return null
  const j = ks.findIndex((k) => k.t > t)
  let a: SetKey
  let b: SetKey
  let u = 0
  if (j === 0) a = b = ks[0]
  else if (j < 0) a = b = ks[ks.length - 1]
  else {
    a = ks[j - 1]
    b = ks[j]
    const span = b.t - a.t
    u = span > 0 ? (t - a.t) / span : 0
    if (item.ease !== "linear") u = u * u * (3 - 2 * u)
  }
  const lerp = (p: Vec3, q: Vec3) => p.map((v, i) => v + (q[i] - v) * u) as Vec3
  const base = item.rotation?.[1] ?? 0
  const ya = a.yaw ?? base
  const yb = b.yaw ?? base
  return {
    position: lerp(a.position, b.position),
    ...(a.target && b.target
      ? {
          target: lerp(a.target, b.target),
          roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * u,
        }
      : {}),
    yaw: ya + (yb - ya) * u,
  }
}

/** `t` on the set's frame grid, to the millisecond (what a key stores). */
export function snapTime(set: FilmSet, t: number): number {
  const f = Math.round(Math.min(Math.max(t, 0), set.duration) * set.fps)
  return Math.round((f / set.fps) * 1000) / 1000
}

/** A free id from a stem: `cam_b`, `cam_c`… or `crate`, `crate-2`… */
export function freeId(set: FilmSet, stem: string): string {
  const taken = new Set(setItems(set).map((e) => e.item.id))
  const clean =
    stem
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  if (!taken.has(clean)) return clean
  for (let n = 2; ; n++) if (!taken.has(`${clean}-${n}`)) return `${clean}-${n}`
}

/** The `add` command for a new item of `kind`, placed near the middle. */
export function addCommand(
  set: FilmSet,
  kind: SetKind,
  asset?: string
): object {
  const n = setItems(set).filter((e) => e.kind === kind).length
  const x = ((n % 5) - 2) * 1.2
  switch (kind) {
    case "prop":
      return {
        type: "add",
        kind,
        item: { id: freeId(set, asset ?? "prop"), asset, position: [x, 0, -1] },
      }
    case "actor":
      return {
        type: "add",
        kind,
        item: {
          id: freeId(set, asset ?? "actor"),
          asset,
          position: [x, 0, 0],
          height: 1.7,
        },
      }
    case "light":
      return {
        type: "add",
        kind,
        item: {
          id: freeId(set, "light"),
          type: "area",
          position: [x, 3, 3],
          target: [0, 1, 0],
          power: 400,
          size: 2,
        },
      }
    case "camera":
      return {
        type: "add",
        kind,
        item: {
          id: freeId(set, `cam_${String.fromCharCode(97 + (n % 26))}`),
          lens: 35,
          keys: [{ t: 0, position: [x + 2, 1.5, 5], target: [0, 1.2, 0] }],
        },
      }
  }
}

/** Keys of an item, if it has any. */
export function keysOf(item: SetItem): SetKey[] | undefined {
  return "keys" in item ? item.keys : undefined
}
