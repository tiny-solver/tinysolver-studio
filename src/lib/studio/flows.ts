/**
 * Flows and their runs (`src-tauri/src/studio_flows.rs`) — the shapes the
 * flow parts (`flow_list` · `run_get` · `run_compare` …) answer with, and the
 * small helpers the run view needs. Every call goes through `studio_run`, the
 * same door the MCP tools and the HTTP API use.
 */

import { studioRun } from "@/lib/api"
import { getTransport } from "@/lib/transport"
import type { StudioOutcome } from "@/lib/types"

export type RunStatus = "running" | "waiting" | "done" | "failed" | "skipped"
export type Pick = "one" | "many" | "text" | "ok"

export interface Want {
  text: string
  good?: string[]
  bad?: string[]
}

export interface FlowSummary {
  id: string
  title?: string | null
  want?: string
  inputs?: string[]
  nodes?: number
  issues: string[]
}

export interface NodeRecord {
  key: string
  node: string
  kind: string
  status: RunStatus
  input: unknown
  output: unknown
  who?: string | null
  started_at: string
  ms: number
  cost_usd?: number | null
  log?: string[]
  note?: string | null
  reused_from?: string | null
}

export interface Card {
  key: string
  ask: string
  show: unknown
  pick: Pick
  since: string
}

export interface RunRecord {
  id: string
  flow: string
  status: RunStatus
  want: Want
  inputs: Record<string, unknown>
  from_run?: string | null
  label?: string | null
  started_at: string
  ended_at?: string | null
  ms: number
  cost_usd: number
  nodes: NodeRecord[]
  waiting: Card[]
  answers: Record<string, unknown>
  output: unknown
  note?: string | null
}

export interface RunSummary {
  flow: string
  run: string
  status: RunStatus
  label?: string | null
  want: string
  from_run?: string | null
  started_at: string
  ended_at?: string | null
  ms: number
  cost_usd: number
  nodes: number
  waiting: { key: string; ask: string }[]
  note?: string | null
}

export interface WaitingCard {
  flow: string
  run: string
  want: string
  card: Card
}

export interface CompareSide {
  status: RunStatus
  input: unknown
  output: unknown
  who?: string | null
  ms: number
  cost_usd?: number | null
  note?: string | null
  reused_from?: string | null
}

export interface CompareRow {
  key: string
  node: string
  flow_changed: boolean
  input_changed: boolean
  output_changed: boolean
  a?: CompareSide | null
  b?: CompareSide | null
}

export interface Comparison {
  a: RunSummary
  b: RunSummary
  want_changed: boolean
  inputs_changed: string[]
  nodes_changed: string[]
  rows: CompareRow[]
}

type Outcome<T> = StudioOutcome & T

async function call<T>(root: string, op: Record<string, unknown>) {
  const out = (await studioRun(root, op as never)) as Outcome<T>
  if (!out.ok) throw new Error(out.note || "failed")
  return out
}

export const listFlows = (root: string) =>
  call<{ flows: FlowSummary[] }>(root, { op: "flow_list" }).then((o) => o.flows)

export const listRuns = (root: string, flow?: string) =>
  call<{ runs: RunSummary[] }>(root, { op: "run_list", flow }).then(
    (o) => o.runs
  )

export const getRun = (root: string, flow: string, run: string) =>
  call<{ run: RunRecord }>(root, { op: "run_get", flow, run }).then(
    (o) => o.run
  )

export const listCards = (root: string) =>
  call<{ cards: WaitingCard[] }>(root, { op: "card_list" }).then((o) => o.cards)

export const compareRuns = (root: string, flow: string, a: string, b: string) =>
  call<Comparison>(root, { op: "run_compare", flow, a, b })

export const startRun = (
  root: string,
  flow: string,
  opts: { from_run?: string; label?: string } = {}
) => call<{ run: string }>(root, { op: "flow_run", flow, ...opts })

export const answerCard = (
  root: string,
  flow: string,
  run: string,
  key: string,
  answer: unknown
) =>
  call<{ status: RunStatus }>(root, {
    op: "run_answer",
    flow,
    run,
    key,
    answer,
  })

/** The server's content projects (server mode only — the door's own op).
 *  `null` where the door is not there (the desktop app). */
export async function listProjects(): Promise<{
  default: string | null
  projects: { name: string; path: string }[]
} | null> {
  try {
    const out = (await getTransport().call("studio/list_projects", {})) as {
      ok: boolean
      default?: string | null
      projects?: { name: string; path: string }[]
    }
    if (!out?.ok) return null
    return { default: out.default ?? null, projects: out.projects ?? [] }
  } catch {
    return null
  }
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i

/** Project-relative picture paths anywhere inside a value, in order. */
export function imagesIn(value: unknown, limit = 24): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (out.length >= limit) return
    if (typeof v === "string") {
      if (IMAGE.test(v) && !v.includes("://") && !out.includes(v)) out.push(v)
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(value)
  return out
}

/** The text a card item is shown with. */
export function itemLabel(item: unknown): string {
  if (typeof item === "string") return item
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>
    const parts = [o.style ?? o.name ?? o.label ?? o.id, o.model]
      .filter((p) => typeof p === "string" && p)
      .join(" · ")
    if (parts) return parts
  }
  return JSON.stringify(item)
}

export const formatMs = (ms: number) =>
  ms < 1000
    ? `${ms}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

export const formatCost = (usd?: number | null) =>
  usd == null ? "" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
