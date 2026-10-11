"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Play, RefreshCw } from "lucide-react"

import { BrowserLink } from "@/components/ui/browser-link"
import { getContentPreview } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { previewBase } from "@/lib/studio/game-url"
import {
  answerCard,
  compareRuns,
  formatCost,
  formatMs,
  getRun,
  imagesIn,
  itemLabel,
  listCards,
  listFlows,
  listRuns,
  startRun,
  type Card,
  type Comparison,
  type CompareSide,
  type FlowSummary,
  type NodeRecord,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type WaitingCard,
} from "@/lib/studio/flows"
import { cn } from "@/lib/utils"

/** How often a running run (and the card list) is read again. */
const POLL_MS = 3000

const STATUS_TONE: Record<RunStatus, string> = {
  running: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  skipped: "bg-muted text-muted-foreground",
}

interface Props {
  root: string
  flow: string | null
  run: string | null
  /** A second run to show beside `run`. */
  compareTo: string | null
  onNavigate: (next: {
    flow?: string | null
    run?: string | null
    b?: string | null
  }) => void
}

/**
 * Flows and their runs (decide layers-l3-flow): the flows of a project, the
 * runs of one, a run node by node — what went in, what came out, who, how
 * long, what it cost — the cards waiting for an answer, and two runs side by
 * side. Everything is read through the flow parts, the same ones Claude
 * Desktop calls over MCP, so a run started there shows up here.
 */
export function StudioFlows({ root, flow, run, compareTo, onNavigate }: Props) {
  const t = useTranslations("StudioFlows")
  const [flows, setFlows] = useState<FlowSummary[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cards, setCards] = useState<WaitingCard[]>([])
  const [record, setRecord] = useState<RunRecord | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getContentPreview(root)
      .then((info) => setBase(previewBase(info)))
      .catch(() => setBase(null))
  }, [root])

  const imageUrl = useCallback(
    (path: string) => (base ? `${base}/${path.replace(/^\/+/, "")}` : null),
    [base]
  )

  const refresh = useCallback(async () => {
    try {
      const [f, r, c] = await Promise.all([
        listFlows(root),
        listRuns(root, flow ?? undefined),
        listCards(root),
      ])
      setFlows(f)
      setRuns(r)
      setCards(c)
      if (flow && run) {
        setRecord(await getRun(root, flow, run))
        setComparison(
          compareTo ? await compareRuns(root, flow, run, compareTo) : null
        )
      } else {
        setRecord(null)
        setComparison(null)
      }
      setError("")
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }, [root, flow, run, compareTo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Follow a run while it moves, and the cards while any are open.
  const live =
    record?.status === "running" ||
    runs.some((r) => r.status === "running") ||
    cards.length > 0
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(id)
  }, [live, refresh])

  const rerun = async (fromRun?: string) => {
    if (!flow) return
    setBusy(true)
    try {
      const out = await startRun(
        root,
        flow,
        fromRun ? { from_run: fromRun } : {}
      )
      onNavigate({ flow, run: out.run, b: null })
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4 text-sm md:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-4 md:w-72">
        <section>
          <h2 className="mb-1 font-semibold">{t("flows")}</h2>
          {flows.length === 0 && (
            <p className="text-muted-foreground">{t("noFlows")}</p>
          )}
          <ul className="flex flex-col gap-1">
            {flows.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onNavigate({ flow: f.id, run: null, b: null })}
                  className={cn(
                    "w-full rounded-md px-2 py-1 text-left hover:bg-muted",
                    f.id === flow && "bg-muted"
                  )}
                >
                  <div className="font-medium">{f.title || f.id}</div>
                  {f.want && (
                    <div className="truncate text-xs text-muted-foreground">
                      {f.want}
                    </div>
                  )}
                  {f.issues.length > 0 && (
                    <div className="text-xs text-red-600">{f.issues[0]}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-semibold">{t("runs")}</h2>
            <div className="flex gap-1">
              {flow && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void rerun()}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  <Play className="size-3" />
                  {t("run")}
                </button>
              )}
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-md border px-1.5 py-0.5 hover:bg-muted"
                aria-label={t("refresh")}
              >
                <RefreshCw className="size-3" />
              </button>
            </div>
          </div>
          {runs.length === 0 && (
            <p className="text-muted-foreground">{t("noRuns")}</p>
          )}
          <ul className="flex flex-col gap-1">
            {runs.map((r) => (
              <li
                key={`${r.flow}/${r.run}`}
                className="flex items-stretch gap-1"
              >
                <button
                  type="button"
                  onClick={() =>
                    onNavigate({ flow: r.flow, run: r.run, b: null })
                  }
                  className={cn(
                    "min-w-0 flex-1 rounded-md px-2 py-1 text-left hover:bg-muted",
                    r.run === run && "bg-muted"
                  )}
                >
                  <div className="flex items-center gap-1">
                    <StatusBadge status={r.status} />
                    <span className="truncate font-mono text-xs">{r.run}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[r.label, formatMs(r.ms), formatCost(r.cost_usd)]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </button>
                {run && r.run !== run && r.flow === flow && (
                  <button
                    type="button"
                    title={t("compareWith")}
                    onClick={() => onNavigate({ flow, run, b: r.run })}
                    className={cn(
                      "rounded-md border px-1.5 text-xs hover:bg-muted",
                      r.run === compareTo && "bg-muted"
                    )}
                  >
                    ⇆
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {error && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {cards.map((c) => (
          <CardBox
            key={`${c.flow}/${c.run}/${c.card.key}`}
            item={c}
            imageUrl={imageUrl}
            onAnswer={async (answer) => {
              await answerCard(root, c.flow, c.run, c.card.key, answer)
              await refresh()
            }}
          />
        ))}
        {comparison ? (
          <CompareView comparison={comparison} imageUrl={imageUrl} />
        ) : record ? (
          <RunView
            record={record}
            imageUrl={imageUrl}
            busy={busy}
            onRerun={() => void rerun(record.id)}
          />
        ) : (
          <p className="text-muted-foreground">{t("pickRun")}</p>
        )}
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations("StudioFlows.status")
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
        STATUS_TONE[status]
      )}
    >
      {t(status)}
    </span>
  )
}

type ImageUrl = (path: string) => string | null

function Thumbs({ paths, imageUrl }: { paths: string[]; imageUrl: ImageUrl }) {
  if (paths.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {paths.map((p) => {
        const url = imageUrl(p)
        return url ? (
          <BrowserLink key={p} href={url} title={p}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={p}
              className="size-28 rounded-md border object-cover"
            />
          </BrowserLink>
        ) : (
          <span key={p} className="font-mono text-xs">
            {p}
          </span>
        )
      })}
    </div>
  )
}

function RunView({
  record,
  imageUrl,
  busy,
  onRerun,
}: {
  record: RunRecord
  imageUrl: ImageUrl
  busy: boolean
  onRerun: () => void
}) {
  const t = useTranslations("StudioFlows")
  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={record.status} />
          <span className="font-mono text-xs">
            {record.flow}/{record.id}
          </span>
          {record.label && <span className="font-medium">{record.label}</span>}
          <span className="text-muted-foreground">
            {[formatMs(record.ms), formatCost(record.cost_usd)]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={onRerun}
            className="ml-auto rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
            title={t("rerunHint")}
          >
            {t("rerun")}
          </button>
        </div>
        <WantBlock want={record.want} />
        {record.from_run && (
          <div className="text-xs text-muted-foreground">
            {t("fromRun", { run: record.from_run })}
          </div>
        )}
        {record.note && (
          <div className="text-red-700 dark:text-red-300">{record.note}</div>
        )}
      </header>
      <ul className="flex flex-col gap-1">
        {record.nodes.map((n) => (
          <NodeRow key={n.key} node={n} imageUrl={imageUrl} />
        ))}
      </ul>
    </div>
  )
}

function WantBlock({ want }: { want: RunRecord["want"] }) {
  const t = useTranslations("StudioFlows")
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div className="font-medium">{want.text}</div>
      {(want.good?.length ?? 0) > 0 && (
        <div className="text-xs text-emerald-700 dark:text-emerald-300">
          {t("good")}: {want.good!.join(" · ")}
        </div>
      )}
      {(want.bad?.length ?? 0) > 0 && (
        <div className="text-xs text-red-700 dark:text-red-300">
          {t("bad")}: {want.bad!.join(" · ")}
        </div>
      )}
    </div>
  )
}

function NodeRow({ node, imageUrl }: { node: NodeRecord; imageUrl: ImageUrl }) {
  const t = useTranslations("StudioFlows")
  const [open, setOpen] = useState(false)
  const depth = (node.key.match(/[.>]/g) ?? []).length
  const leaf = !["seq", "parallel", "each", "if", "repeat"].includes(node.kind)
  const pictures = useMemo(
    () => (leaf ? imagesIn(node.output, 8) : []),
    [leaf, node.output]
  )
  return (
    <li className="rounded-md border" style={{ marginLeft: depth * 16 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <StatusBadge status={node.status} />
        <span className="font-mono text-xs">{node.key}</span>
        <span className="text-xs text-muted-foreground">{node.kind}</span>
        {node.who && <span className="text-xs">{node.who}</span>}
        {node.reused_from && (
          <span className="text-xs text-muted-foreground">{t("reused")}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {[formatMs(node.ms), formatCost(node.cost_usd)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      {node.note && (
        <div className="px-2 pb-1 text-xs text-red-700 dark:text-red-300">
          {node.note}
        </div>
      )}
      {pictures.length > 0 && (
        <div className="px-2 pb-2">
          <Thumbs paths={pictures} imageUrl={imageUrl} />
        </div>
      )}
      {open && (
        <div className="grid gap-2 border-t p-2 md:grid-cols-2">
          <JsonBlock label={t("input")} value={node.input} />
          <JsonBlock label={t("output")} value={node.output} />
          {(node.log?.length ?? 0) > 0 && (
            <JsonBlock label={t("log")} value={node.log!.join("\n")} />
          )}
        </div>
      )}
    </li>
  )
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/50 p-2 text-[11px] whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  )
}

function CardBox({
  item,
  imageUrl,
  onAnswer,
}: {
  item: WaitingCard
  imageUrl: ImageUrl
  onAnswer: (answer: unknown) => Promise<void>
}) {
  const t = useTranslations("StudioFlows")
  const card: Card = item.card
  const items = Array.isArray(card.show) ? card.show : []
  const [picked, setPicked] = useState<number[]>([])
  const [note, setNote] = useState("")
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")

  const toggle = (i: number) =>
    setPicked((p) =>
      card.pick === "one"
        ? [i]
        : p.includes(i)
          ? p.filter((x) => x !== i)
          : [...p, i]
    )

  const send = async (answer: unknown) => {
    setSending(true)
    try {
      await onAnswer(answer)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const withNote = (v: Record<string, unknown>) =>
    note.trim() ? { ...v, note } : v

  return (
    <section className="rounded-lg border-2 border-amber-400/60 bg-amber-50/40 p-3 dark:bg-amber-950/20">
      <div className="mb-1 text-xs text-muted-foreground">
        {t("cardFrom", { flow: item.flow, run: item.run })}
      </div>
      <div className="mb-2 font-semibold">{card.ask}</div>
      {items.length > 0 && (
        <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((it, i) => {
            const pic = imagesIn(it, 1)[0]
            const url = pic ? imageUrl(pic) : null
            const on = picked.includes(i)
            return (
              <button
                key={i}
                type="button"
                disabled={card.pick === "text" || card.pick === "ok"}
                onClick={() => toggle(i)}
                className={cn(
                  "flex flex-col gap-1 rounded-md border p-1 text-left",
                  on && "ring-2 ring-amber-500"
                )}
              >
                {url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={itemLabel(it)}
                    className="aspect-square w-full rounded object-cover"
                  />
                )}
                <span className="text-xs">
                  {i}. {itemLabel(it)}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {card.pick === "text" ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="mb-2 w-full rounded-md border bg-background p-2"
          rows={2}
        />
      ) : (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("notePlaceholder")}
          className="mb-2 w-full rounded-md border bg-background px-2 py-1"
        />
      )}
      <div className="flex gap-2">
        {card.pick === "ok" ? (
          <>
            <button
              type="button"
              disabled={sending}
              onClick={() => void send(withNote({ ok: true }))}
              className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
            >
              {t("goOn")}
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void send(withNote({ ok: false }))}
              className="rounded-md border px-3 py-1"
            >
              {t("stop")}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={
              sending ||
              (card.pick === "text" ? !text.trim() : picked.length === 0)
            }
            onClick={() =>
              void send(
                card.pick === "text"
                  ? { text }
                  : card.pick === "one"
                    ? withNote({ index: picked[0] })
                    : withNote({ indexes: picked })
              )
            }
            className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
          >
            {t("answer")}
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  )
}

function CompareView({
  comparison,
  imageUrl,
}: {
  comparison: Comparison
  imageUrl: ImageUrl
}) {
  const t = useTranslations("StudioFlows")
  const [all, setAll] = useState(false)
  const rows = all
    ? comparison.rows
    : comparison.rows.filter(
        (r) => r.flow_changed || r.input_changed || r.output_changed
      )
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        {[comparison.a, comparison.b].map((s) => (
          <div key={s.run} className="rounded-md bg-muted/50 px-3 py-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={s.status} />
              <span className="font-mono text-xs">{s.run}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {[s.label, formatMs(s.ms), formatCost(s.cost_usd)]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        ))}
      </div>
      <div className="text-xs">
        {comparison.nodes_changed.length > 0 && (
          <div>
            {t("nodesChanged")}: <b>{comparison.nodes_changed.join(", ")}</b>
          </div>
        )}
        {comparison.inputs_changed.length > 0 && (
          <div>
            {t("inputsChanged")}: <b>{comparison.inputs_changed.join(", ")}</b>
          </div>
        )}
        {comparison.want_changed && <div>{t("wantChanged")}</div>}
        <label className="mt-1 flex items-center gap-1">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          {t("showSame")}
        </label>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.key} className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-2 py-1">
              <span className="font-mono text-xs">{r.key}</span>
              {r.flow_changed && <Tag>{t("changedFlow")}</Tag>}
              {r.input_changed && <Tag>{t("changedInput")}</Tag>}
              {r.output_changed && <Tag>{t("changedOutput")}</Tag>}
            </div>
            <div className="grid grid-cols-2 gap-2 p-2">
              <Side side={r.a} imageUrl={imageUrl} />
              <Side side={r.b} imageUrl={imageUrl} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-800 dark:text-amber-200">
      {children}
    </span>
  )
}

function Side({
  side,
  imageUrl,
}: {
  side?: CompareSide | null
  imageUrl: ImageUrl
}) {
  const t = useTranslations("StudioFlows")
  if (!side)
    return <div className="text-xs text-muted-foreground">{t("absent")}</div>
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <StatusBadge status={side.status} />
        {side.who}
        <span className="text-muted-foreground">
          {[formatMs(side.ms), formatCost(side.cost_usd)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {side.reused_from && (
          <span className="text-muted-foreground">{t("reused")}</span>
        )}
      </div>
      <Thumbs paths={imagesIn(side.output, 6)} imageUrl={imageUrl} />
      <JsonBlock label={t("output")} value={side.output} />
    </div>
  )
}
