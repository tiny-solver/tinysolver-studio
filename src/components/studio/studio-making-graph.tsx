"use client"

import { createContext, memo, useContext, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { formatCost, formatMs } from "@/lib/studio/flows"
import {
  depths,
  PORT_TYPES,
  type Graph,
  type GraphNode,
  type Port,
  type PortType,
} from "@/lib/studio/library"
import { cn } from "@/lib/utils"

/** Port colour = the kind of data on the wire (ComfyUI's habit). */
export const PORT_COLOR: Record<PortType, string> = {
  TEXT: "#d9b45f",
  IMAGE: "#5aa9e6",
  MESH: "#7fc47f",
  RIGGED: "#45b5a8",
  LIMBS: "#b67fd6",
  ANIM: "#f08a5d",
  VIDEO: "#e46fa0",
  REPORT: "#a3a8b1",
  DATA: "#7d828c",
}

const NODE_W = 290
const COL_GAP = 70
const ROW_GAP = 36

/** Resolves a card's picture: a project-relative path, or a material's file
 *  (a model gets its rendered thumbnail). */
export type ThumbUrl = (t: GraphNode["thumbs"][number]) => string | null
const ThumbContext = createContext<ThumbUrl>(() => null)

/** A rough card height, to stack a column before the browser measures. */
function heightOf(n: GraphNode): number {
  return (
    44 +
    (n.ins.length + n.outs.length) * 26 +
    (n.ins.length ? 18 : 0) +
    (n.outs.length ? 18 : 0) +
    (n.settings.length ? n.settings.length * 18 + 14 : 0) +
    (n.thumbs.length ? 96 : 0) +
    n.notes.length * 34
  )
}

/** Columns wrap after this many, so a long pipeline reads in rows (the
 *  way a page reads) instead of shrinking to fit one line. */
const MAX_COLS = 4
const BAND_GAP = 90

function layout(graph: Graph, dim: boolean) {
  const depth = depths(graph)
  const place = (n: GraphNode) => {
    const d = depth.get(n.id) ?? 0
    return { col: d % MAX_COLS, band: Math.floor(d / MAX_COLS) }
  }
  // Stack each column of each band, then set the bands one under another.
  const stack = new Map<string, number>()
  const local = new Map<string, number>()
  const bandH = new Map<number, number>()
  for (const n of graph.nodes) {
    const { col, band } = place(n)
    const at = stack.get(`${band}/${col}`) ?? 0
    local.set(n.id, at)
    stack.set(`${band}/${col}`, at + heightOf(n) + ROW_GAP)
    bandH.set(band, Math.max(bandH.get(band) ?? 0, at + heightOf(n)))
  }
  const bandY = (band: number) =>
    [...Array(band).keys()].reduce(
      (y, b) => y + (bandH.get(b) ?? 0) + BAND_GAP,
      0
    )
  const nodes: Node<{ node: GraphNode; dim: boolean }>[] = graph.nodes.map(
    (n) => {
      const { col, band } = place(n)
      return {
        id: n.id,
        type: "making",
        position: {
          x: col * (NODE_W + COL_GAP),
          y: bandY(band) + (local.get(n.id) ?? 0),
        },
        data: { node: n, dim },
        draggable: true,
      }
    }
  )
  const bands = Math.max(0, ...bandH.keys()) + 1
  const height = bandY(bands - 1) + (bandH.get(bands - 1) ?? 0)
  const cols = Math.min(MAX_COLS, Math.max(1, ...depth.values()) + 1)
  const width = cols * (NODE_W + COL_GAP)
  const owner = new Map<string, string>()
  for (const n of graph.nodes)
    for (const p of [...n.ins, ...n.outs]) owner.set(p.id, n.id)
  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e${i}`,
    source: owner.get(e.from)!,
    sourceHandle: e.from,
    target: owner.get(e.to)!,
    targetHandle: e.to,
    animated: !dim,
    style: {
      stroke: PORT_COLOR[e.type],
      strokeWidth: 2.5,
      opacity: dim ? 0.5 : 0.9,
    },
  }))
  return { nodes, edges, height, width }
}

function PortRow({ port, side }: { port: Port; side: "in" | "out" }) {
  const color = PORT_COLOR[port.type]
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2 px-2.5 py-1 text-[12.5px]",
        side === "out" && "justify-end text-right"
      )}
    >
      <Handle
        type={side === "in" ? "target" : "source"}
        position={side === "in" ? Position.Left : Position.Right}
        id={port.id}
        isConnectable={false}
        style={{
          background: color,
          width: 10,
          height: 10,
          border: "2px solid #16181c",
          boxShadow: `0 0 0 1px ${color}`,
        }}
      />
      {side === "in" && (
        <span className="font-mono text-[10px] font-semibold" style={{ color }}>
          {port.type}
        </span>
      )}
      <span className="min-w-0 break-words text-zinc-100" title={port.key}>
        {port.text}
      </span>
      {side === "out" && (
        <span className="font-mono text-[10px] font-semibold" style={{ color }}>
          {port.type}
        </span>
      )}
    </div>
  )
}

const MakingNode = memo(function MakingNode({
  data,
}: NodeProps<Node<{ node: GraphNode; dim: boolean }>>) {
  const t = useTranslations("StudioLibrary")
  const thumbUrl = useContext(ThumbContext)
  const { node: n, dim } = data
  const failed = n.status === "failed"
  const where = [
    n.where,
    n.ms ? formatMs(n.ms) : "",
    n.costUsd ? formatCost(n.costUsd) : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <section
      className={cn(
        "rounded-lg border border-zinc-700 bg-zinc-800 shadow-lg shadow-black/40",
        failed && "border-red-400/60",
        dim && "opacity-60"
      )}
      style={{ width: NODE_W }}
    >
      <header className="flex items-baseline gap-2 rounded-t-lg border-b border-zinc-700 bg-zinc-700/60 px-2.5 py-2">
        <span className="min-w-0 flex-1 text-sm font-semibold text-zinc-50">
          {n.title}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-zinc-400">
          {where}
        </span>
      </header>
      <div className="pb-2.5 pt-1">
        {n.ins.length > 0 && (
          <>
            <div className="px-2.5 pt-1 font-mono text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              in
            </div>
            {n.ins.map((p) => (
              <PortRow key={p.id} port={p} side="in" />
            ))}
          </>
        )}
        {n.settings.length > 0 && (
          <dl className="mx-2.5 my-1 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 rounded bg-zinc-900/70 px-2 py-1.5 font-mono text-[11.5px]">
            {n.settings.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-400">{k}</dt>
                <dd className="m-0 text-right break-all text-zinc-100">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {n.thumbs.length > 0 && (
          <div className="flex gap-1 px-2.5 pt-1 pb-1.5">
            {n.thumbs.slice(0, 4).map((th) => {
              const url = thumbUrl(th)
              return url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={th.path}
                  src={url}
                  alt={th.path}
                  className="aspect-square max-h-24 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-300 object-cover"
                />
              ) : (
                <div
                  key={th.path}
                  className="flex aspect-square max-h-24 min-w-0 flex-1 items-center justify-center rounded border border-zinc-700 text-[10px] text-zinc-500"
                >
                  {th.path.split("/").pop()}
                </div>
              )
            })}
          </div>
        )}
        {n.outs.length > 0 && (
          <>
            <div className="px-2.5 pt-1 text-right font-mono text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
              out
            </div>
            {n.outs.map((p) => (
              <PortRow key={p.id} port={p} side="out" />
            ))}
          </>
        )}
        {failed && (
          <div className="px-2.5 pt-1 text-xs font-semibold text-red-300">
            {t("nodeFailed")}
          </div>
        )}
        {n.notes.map((note, i) => (
          <p
            key={i}
            className="m-0 px-2.5 pt-1.5 text-[12px] leading-snug text-zinc-400"
          >
            {note}
          </p>
        ))}
      </div>
    </section>
  )
})

const NODE_TYPES = { making: MakingNode }

function Canvas({ graph, dim }: { graph: Graph; dim: boolean }) {
  const { nodes, edges, height, width } = useMemo(
    () => layout(graph, dim),
    [graph, dim]
  )
  return (
    <div
      className="max-h-[1100px] min-h-[380px] w-full overflow-hidden rounded-lg border border-zinc-800 bg-[#16181c]"
      // As tall as the graph is at roughly full size across the page.
      style={{ aspectRatio: `${width} / ${Math.max(height, 300) + 60}` }}
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.15}
          maxZoom={1.6}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background gap={24} color="#262a31" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}

function Totals({ graph }: { graph: Graph }) {
  const t = useTranslations("StudioLibrary")
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted-foreground">
      <span>
        {t("steps")} <b className="text-foreground">{graph.nodes.length}</b>
      </span>
      {graph.ms > 0 && (
        <span>
          {t("time")} <b className="text-foreground">{formatMs(graph.ms)}</b>
        </span>
      )}
      <span>
        {t("cost")}{" "}
        <b className="text-foreground">
          {graph.costUsd > 0 ? formatCost(graph.costUsd) : "$0"}
        </b>
      </span>
      <span>
        {t("from")}{" "}
        <b className="text-foreground">
          {graph.origin === "chain" ? t("fromChain") : graph.origin}
        </b>
      </span>
    </div>
  )
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[11px] text-muted-foreground">
      {PORT_TYPES.map((type) => (
        <span key={type} className="inline-flex items-center gap-1.5">
          <i
            className="inline-block size-2.5 rounded-full"
            style={{ background: PORT_COLOR[type] }}
          />
          {type}
        </span>
      ))}
    </div>
  )
}

/** One making graph: the run (or register chain) that made the material,
 *  and its failed tries dimmed below. */
export function MakingGraphView({
  main,
  failed,
  thumbUrl,
}: {
  main: Graph
  failed: Graph[]
  thumbUrl: ThumbUrl
}) {
  const t = useTranslations("StudioLibrary")
  return (
    <ThumbContext.Provider value={thumbUrl}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="text-sm font-medium">{main.label}</div>
          <Legend />
        </div>
        <Canvas graph={main} dim={false} />
        <Totals graph={main} />
        {failed.length > 0 && (
          <section className="mt-6 flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{t("failedTries")}</h3>
            {failed.map((g) => (
              <div key={g.origin} className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{g.origin}</span> — {g.label}
                </p>
                <Canvas graph={g} dim />
              </div>
            ))}
          </section>
        )}
      </div>
    </ThumbContext.Provider>
  )
}
