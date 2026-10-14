"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeft, Box, Columns2, RefreshCw, Workflow } from "lucide-react"

import { MakingGraphView } from "@/components/studio/studio-making-graph"
import { formatBytes } from "@/components/studio/studio-materials"
import { toErrorMessage } from "@/lib/app-error"
import { getRun, listRuns, type RunRecord } from "@/lib/studio/flows"
import {
  clipsOf,
  compareUrl,
  fileUrl,
  loadLibrary,
  makingGraph,
  modelItems,
  projectUrl,
  type LibraryItem,
  type LibraryProject,
  type MakingGraph,
  type Role,
} from "@/lib/studio/library"
import { cn } from "@/lib/utils"

/** Runs read per project for the making graph (newest first). */
const MAX_RUNS = 40
const THUMB_STORE = "studio-library-thumbs"

interface Props {
  fallbackRoot: string | null
  /** Picked for side by side (`?sel=a,b`). */
  selected: string[]
  /** The one whose making graph is open (`?item=`). */
  item: string | null
  /** Side by side is open (`?view=compare`). */
  comparing: boolean
  onNavigate: (next: {
    sel?: string[]
    item?: string | null
    view?: "compare" | null
  }) => void
}

/** Rendered model thumbnails by GLB URL, kept for the tab's life. */
function useThumbnails(items: LibraryItem[]) {
  const [thumbs, setThumbs] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(THUMB_STORE) ?? "{}")
    } catch {
      return {}
    }
  })
  const asked = useRef(new Set<string>())
  const [frame, setFrame] = useState<string | null>(null)
  // One hidden viewer at a time renders up to 12 models it has not drawn;
  // when it says done, the next batch goes.
  useEffect(() => {
    if (frame) return
    const abs = (it: LibraryItem) => {
      const url = fileUrl(it.project, it.asset.file)
      return url ? new URL(url, location.href).href : null
    }
    const batch = items
      .filter((it) => {
        const url = abs(it)
        return (
          !!url &&
          it.asset.exists &&
          !(url in thumbs) &&
          !asked.current.has(url)
        )
      })
      .slice(0, 12)
    if (batch.length === 0) return
    for (const it of batch) asked.current.add(abs(it)!)
    const url = compareUrl(batch, { thumb: true })
    queueMicrotask(() => setFrame(url))
  }, [items, thumbs, frame])
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type === "codeg-thumb" && typeof e.data.src === "string") {
        setThumbs((t) => {
          const next = { ...t, [e.data.src]: e.data.url ?? "" }
          try {
            sessionStorage.setItem(THUMB_STORE, JSON.stringify(next))
          } catch {
            // a full or blocked store only costs a re-render next visit
          }
          return next
        })
      } else if (e.data?.type === "codeg-thumb-done") setFrame(null)
    }
    addEventListener("message", on)
    return () => removeEventListener("message", on)
  }, [])
  const thumbOf = useCallback(
    (project: LibraryProject, file: string) => {
      const url = fileUrl(project, file)
      return url ? thumbs[new URL(url, location.href).href] || null : null
    },
    [thumbs]
  )
  return { thumbOf, frame }
}

/**
 * The 3D library (decide 3d-gallery-graph): every project's 3D materials as a
 * grid, two or more side by side under one camera, and one as the graph of
 * how it was made — read from the register's `source.from` chain and the
 * flow runs that produced it.
 */
export function StudioLibrary({
  fallbackRoot,
  selected,
  item,
  comparing,
  onNavigate,
}: Props) {
  const t = useTranslations("StudioLibrary")
  const [projects, setProjects] = useState<LibraryProject[] | null>(null)
  const [error, setError] = useState("")
  const [role, setRole] = useState<Role | "all">("all")

  const [reads, setReads] = useState(0)
  const refresh = () => setReads((n) => n + 1)
  useEffect(() => {
    let live = true
    loadLibrary(fallbackRoot)
      .then((next) => {
        if (!live) return
        setProjects(next)
        setError("")
      })
      .catch((e) => live && setError(toErrorMessage(e)))
    return () => {
      live = false
    }
  }, [fallbackRoot, reads])

  const items = useMemo(() => modelItems(projects ?? []), [projects])
  const { thumbOf, frame } = useThumbnails(items)
  const shown = items.filter((i) => role === "all" || i.role === role)
  const picked = selected
    .map((k) => items.find((i) => i.key === k))
    .filter((i): i is LibraryItem => !!i)
  const open = item ? items.find((i) => i.key === item) : undefined

  const toggle = (key: string) =>
    onNavigate({
      sel: selected.includes(key)
        ? selected.filter((k) => k !== key)
        : [...selected, key],
    })

  const thumbFrame = frame && (
    <iframe
      src={frame}
      title="thumbnails"
      aria-hidden
      className="pointer-events-none fixed -left-[10000px] top-0 size-80"
    />
  )

  if (open)
    return (
      <div className="flex min-h-full flex-col gap-4 p-4 text-sm">
        {thumbFrame}
        <GraphPage
          item={open}
          thumbOf={thumbOf}
          onBack={() => onNavigate({ item: null })}
        />
      </div>
    )

  if (comparing && picked.length >= 2)
    return (
      <div className="flex min-h-full flex-col gap-4 p-4 text-sm">
        <ComparePage
          items={picked}
          onBack={() => onNavigate({ view: null })}
          onGraph={(key) => onNavigate({ item: key })}
        />
      </div>
    )

  const roles: (Role | "all")[] = ["all", "character", "prop", "scene"]
  return (
    <div className="flex min-h-full flex-col gap-4 p-4 text-sm">
      {thumbFrame}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap gap-1">
          {roles.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs hover:bg-muted",
                role === r && "border-foreground bg-muted"
              )}
            >
              {t(`role.${r}`)}{" "}
              <span className="text-muted-foreground">
                {r === "all"
                  ? items.length
                  : items.filter((i) => i.role === r).length}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={picked.length < 2}
            onClick={() => onNavigate({ view: "compare", item: null })}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40"
          >
            <Columns2 className="size-3.5" />
            {t("compare", { n: picked.length })}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border p-1.5 hover:bg-muted"
            aria-label={t("refresh")}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </header>
      <p className="-mt-2 text-xs text-muted-foreground">{t("hint")}</p>
      {error && <p className="text-red-600">{error}</p>}
      {projects
        ?.filter((p) => p.error)
        .map((p) => (
          <p key={p.root} className="text-xs text-red-600">
            {p.name}: {p.error}
          </p>
        ))}
      {projects && shown.length === 0 && (
        <p className="text-muted-foreground">{t("empty")}</p>
      )}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {shown.map((it) => (
          <ItemCard
            key={it.key}
            item={it}
            thumb={thumbOf(it.project, it.asset.file)}
            picked={selected.includes(it.key)}
            onPick={() => toggle(it.key)}
            onOpen={() => onNavigate({ item: it.key })}
          />
        ))}
      </ul>
    </div>
  )
}

function factsOf(it: LibraryItem, t: ReturnType<typeof useTranslations>) {
  const a = it.asset
  const clips = clipsOf(a)
  return [
    [t("tris"), a.triangles != null ? a.triangles.toLocaleString() : "—"],
    [t("bones"), a.bones ? String(a.bones) : "—"],
    [
      t("clips"),
      clips.length
        ? clips.map((c) => `${c.name} ${c.seconds}s`).join(" · ")
        : a.animations
          ? String(a.animations)
          : "—",
    ],
    [t("size"), formatBytes(a.bytes) || "—"],
    [t("made"), a.added_at ? a.added_at.slice(0, 10) : "—"],
  ] as const
}

function ItemCard({
  item,
  thumb,
  picked,
  onPick,
  onOpen,
}: {
  item: LibraryItem
  thumb: string | null
  picked: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const t = useTranslations("StudioLibrary")
  return (
    <li
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card",
        picked && "ring-2 ring-emerald-500"
      )}
    >
      <label className="absolute top-1.5 left-1.5 z-10 flex items-center rounded bg-background/80 p-1">
        <input
          type="checkbox"
          checked={picked}
          onChange={onPick}
          aria-label={t("pick")}
        />
      </label>
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-col text-left"
        title={t("openGraph")}
      >
        <div className="flex aspect-square items-center justify-center bg-[#20232a]">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumb}
              alt={item.asset.id}
              className="size-full object-cover"
            />
          ) : (
            <Box className="size-8 text-zinc-500" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1 p-2">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10.5px] whitespace-nowrap">
              {t(`role.${item.role}`)}
            </span>
            <span className="truncate font-medium">{item.asset.id}</span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {item.project.name} · {item.asset.file}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11.5px]">
            {factsOf(item, t).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="m-0 truncate" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {!item.asset.exists && (
            <div className="text-[11px] text-red-600">{t("missing")}</div>
          )}
        </div>
      </button>
    </li>
  )
}

function ComparePage({
  items,
  onBack,
  onGraph,
}: {
  items: LibraryItem[]
  onBack: () => void
  onGraph: (key: string) => void
}) {
  const t = useTranslations("StudioLibrary")
  const url = compareUrl(items)
  const rows: [string, (it: LibraryItem) => string][] = [
    [t("project"), (it) => it.project.name],
    [t("kind"), (it) => t(`role.${it.role}`)],
    [t("tris"), (it) => it.asset.triangles?.toLocaleString() ?? "—"],
    [t("vertices"), (it) => it.asset.vertices?.toLocaleString() ?? "—"],
    [t("bones"), (it) => (it.asset.bones ? String(it.asset.bones) : "—")],
    [
      t("clips"),
      (it) =>
        clipsOf(it.asset)
          .map((c) => `${c.name} ${c.seconds}s`)
          .join(" · ") || "—",
    ],
    [
      t("texture"),
      (it) =>
        (it.asset.textures ?? []).map(([w, h]) => `${w}×${h}`).join(" · ") ||
        "—",
    ],
    [t("size"), (it) => formatBytes(it.asset.bytes) || "—"],
    [
      t("how"),
      (it) =>
        [it.asset.source?.workflow, it.asset.source?.kind]
          .filter(Boolean)
          .join(" · ") || "—",
    ],
    [t("made"), (it) => it.asset.added_at?.slice(0, 10) ?? "—"],
  ]
  return (
    <>
      <header className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </button>
        <h1 className="text-lg font-semibold">
          {t("compareTitle", { n: items.length })}
        </h1>
        <span className="text-xs text-muted-foreground">
          {t("compareHint")}
        </span>
      </header>
      {url ? (
        <iframe
          src={url}
          title={t("compareTitle", { n: items.length })}
          className="h-[60vh] min-h-80 w-full rounded-lg border bg-[#20232a]"
        />
      ) : (
        <p className="text-muted-foreground">{t("noPreview")}</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b p-1.5 text-left font-normal text-muted-foreground" />
              {items.map((it) => (
                <th key={it.key} className="border-b p-1.5 text-left">
                  <button
                    type="button"
                    onClick={() => onGraph(it.key)}
                    className="inline-flex items-center gap-1 font-semibold hover:underline"
                    title={t("openGraph")}
                  >
                    <Workflow className="size-3.5" />
                    {it.asset.id}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, cell]) => {
              const values = items.map(cell)
              const differs = new Set(values).size > 1
              return (
                <tr key={label}>
                  <th className="border-b p-1.5 text-left font-normal whitespace-nowrap text-muted-foreground">
                    {label}
                  </th>
                  {values.map((v, i) => (
                    <td
                      key={items[i].key}
                      className={cn(
                        "border-b p-1.5 font-mono",
                        differs && "bg-amber-500/10"
                      )}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function GraphPage({
  item,
  thumbOf,
  onBack,
}: {
  item: LibraryItem
  thumbOf: (project: LibraryProject, file: string) => string | null
  onBack: () => void
}) {
  const t = useTranslations("StudioLibrary")
  const [graph, setGraph] = useState<MakingGraph | null>(null)
  const [error, setError] = useState("")
  const { project, asset } = item

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const summaries = (await listRuns(project.root)).slice(0, MAX_RUNS)
        const runs = (
          await Promise.all(
            summaries.map((s) =>
              getRun(project.root, s.flow, s.run).catch(() => null)
            )
          )
        ).filter((r): r is RunRecord => !!r)
        if (live) setGraph(makingGraph(asset, project.assets, runs))
      } catch (e) {
        if (live) setError(toErrorMessage(e))
      }
    })()
    return () => {
      live = false
    }
  }, [project, asset])

  const viewer = compareUrl([item])
  return (
    <>
      <header className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </button>
        <h1 className="text-lg font-semibold">
          {t("graphTitle", { id: asset.id })}
        </h1>
        <span className="text-xs text-muted-foreground">
          {project.name} · {asset.file}
        </span>
      </header>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {error && <p className="text-red-600">{error}</p>}
          {graph ? (
            <MakingGraphView
              main={graph.main}
              failed={graph.failed}
              thumbUrl={(th) =>
                th.material
                  ? /\.(glb|gltf)$/i.test(th.path)
                    ? thumbOf(project, th.path)
                    : fileUrl(project, th.path)
                  : projectUrl(project, th.path)
              }
            />
          ) : (
            !error && <p className="text-muted-foreground">{t("loading")}</p>
          )}
        </div>
        {viewer && (
          <iframe
            src={viewer}
            title={asset.id}
            className="order-first h-80 w-full rounded-lg border bg-[#20232a] lg:order-none lg:sticky lg:top-4"
          />
        )}
      </div>
    </>
  )
}
