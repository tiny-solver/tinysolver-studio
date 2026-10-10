"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Camera,
  Clapperboard,
  Lamp,
  Move3d,
  Package,
  Pause,
  Play,
  Plus,
  Rotate3d,
  Trash2,
  User,
} from "lucide-react"

import { getContentPreview, studioRun } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { previewBase } from "@/lib/studio/game-url"
import {
  addCommand,
  findItem,
  keysOf,
  sampleKeys,
  snapTime,
  type FilmSet,
  type SetCamera,
  type SetKind,
  type SetOutcome,
  type SetSummary,
  type Vec3,
} from "@/lib/studio/film-set"
import type { StudioAsset, StudioAssetList, StudioOutcome } from "@/lib/types"
import { cn } from "@/lib/utils"

/** How often the set file is re-read for an agent's edits. */
const POLL_MS = 2000

const KIND_ICON = {
  prop: Package,
  actor: User,
  light: Lamp,
  camera: Camera,
} as const

/**
 * The 3D set view (decide fs3-set): the film set document drawn in three.js
 * (`__codeg/viewer/set.html` from the preview server), a list and fields
 * beside it, a timeline under it.
 *
 * Nothing here edits the file: every change — a drag in the view, a field,
 * a button — is a set command sent through `studio_run`
 * (`apply_set_commands`), the operation the agents' MCP tool runs, and the
 * view is handed the document that comes back. An agent's edit reaches the
 * screen by the file being read again.
 */
export function StudioFilmSet({ projectRoot }: { projectRoot: string }) {
  const t = useTranslations("StudioSet")
  const [sets, setSets] = useState<SetSummary[]>([])
  const [setId, setSetId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<SetOutcome | null>(null)
  const [models, setModels] = useState<StudioAsset[]>([])
  const [base, setBase] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState("free")
  const [mode, setMode] = useState<"translate" | "rotate">("translate")
  const [busy, setBusy] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState("")
  const [newName, setNewName] = useState("")
  const [rendered, setRendered] = useState<{ file: string } | null>(null)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const ready = useRef(false)
  const last = useRef("")
  const state = useRef({ selected, time, view, mode })
  state.current = { selected, time, view, mode }

  const set = outcome?.file ?? null

  const post = useCallback((msg: object) => {
    frame.current?.contentWindow?.postMessage(msg, "*")
  }, [])

  const show = useCallback(
    (next: SetOutcome) => {
      last.current = JSON.stringify(next.file)
      setOutcome(next)
      if (!ready.current || !base) return
      const urls = Object.fromEntries(
        Object.entries(next.models).map(([id, file]) => [
          id,
          `../../${next.assets_dir}/${file}`,
        ])
      )
      post({
        type: "codeg-set:load",
        set: next.file,
        models: urls,
        selected: state.current.selected,
        t: state.current.time,
        view: state.current.view,
        mode: state.current.mode,
      })
    },
    [base, post]
  )

  const listSets = useCallback(async () => {
    const res = await studioRun<StudioOutcome & { sets?: SetSummary[] }>(
      projectRoot,
      { op: "list_sets" }
    )
    const list = res.ok ? (res.sets ?? []) : []
    setSets(list)
    setSetId((cur) => cur ?? list.find((s) => !s.error)?.id ?? null)
  }, [projectRoot])

  useEffect(() => {
    void listSets().catch((e) => setError(toErrorMessage(e)))
    void (async () => {
      const info = await getContentPreview(projectRoot).catch(() => null)
      if (info) setBase(`${previewBase(info)}/`)
      const list = await studioRun<StudioAssetList>(projectRoot, {
        op: "list_assets",
      }).catch(() => null)
      if (list?.ok) setModels(list.assets.filter((a) => a.kind === "model"))
    })()
  }, [projectRoot, listSets])

  const read = useCallback(
    async (id: string) => {
      const res = await studioRun<SetOutcome>(projectRoot, {
        op: "read_set",
        set: id,
      })
      if (!res.ok) {
        setError(res.note ?? "")
        return
      }
      if (JSON.stringify(res.file) !== last.current) show(res)
      else setOutcome((o) => (o ? { ...o, issues: res.issues } : res))
    },
    [projectRoot, show]
  )

  useEffect(() => {
    if (!setId) return
    last.current = ""
    void read(setId)
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read(setId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [setId, read])

  const apply = useCallback(
    async (commands: object[]) => {
      if (!setId) return
      setBusy(true)
      setError("")
      try {
        const res = await studioRun<SetOutcome>(projectRoot, {
          op: "apply_set_commands",
          set: setId,
          commands,
        })
        if (res.ok) show(res)
        else {
          setError(res.note ?? "")
          // Put the view back where the file says.
          if (outcome) show(outcome)
        }
      } catch (e) {
        setError(toErrorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [projectRoot, setId, show, outcome]
  )

  // The view's messages.
  const applyRef = useRef(apply)
  applyRef.current = apply
  const outcomeRef = useRef(outcome)
  outcomeRef.current = outcome
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data as { type?: string; [k: string]: unknown }
      if (m?.type === "codeg-set:ready") {
        ready.current = true
        if (outcomeRef.current) show(outcomeRef.current)
      } else if (m?.type === "codeg-set:select") {
        setSelected((m.id as string | null) ?? null)
      } else if (m?.type === "codeg-set:commands") {
        void applyRef.current(m.commands as object[])
      } else if (m?.type === "codeg-set:error") {
        setError(String(m.message ?? ""))
      }
    }
    addEventListener("message", onMessage)
    return () => removeEventListener("message", onMessage)
  }, [show])

  useEffect(() => post({ type: "codeg-set:time", t: time }), [time, post])
  useEffect(
    () => post({ type: "codeg-set:select", id: selected }),
    [selected, post]
  )
  useEffect(() => post({ type: "codeg-set:view", view }), [view, post])
  useEffect(() => post({ type: "codeg-set:mode", mode }), [mode, post])

  // Playback: real time, looping.
  useEffect(() => {
    if (!playing || !set) return
    let raf = 0
    let prev = performance.now()
    const step = (now: number) => {
      const dt = (now - prev) / 1000
      prev = now
      setTime((v) => (v + dt > set.duration ? 0 : v + dt))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, set])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    const id =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `set-${sets.length + 1}`
    setBusy(true)
    setError("")
    const res = await studioRun<SetOutcome>(projectRoot, {
      op: "create_set",
      set: id,
      name,
    }).catch((e) => ({ ok: false, note: toErrorMessage(e) }) as SetOutcome)
    setBusy(false)
    if (!res.ok) {
      setError(res.note ?? "")
      return
    }
    setNewName("")
    await listSets()
    setSetId(id)
  }

  const cameraForRender =
    (view !== "free" && view) ||
    (set && findItem(set, selected)?.kind === "camera" ? selected : null) ||
    set?.cameras[0]?.id ||
    null

  const render = async () => {
    if (!set || !setId || !cameraForRender) return
    setRendering(true)
    setError("")
    setRendered(null)
    try {
      const res = await studioRun<StudioOutcome & { video?: { file: string } }>(
        projectRoot,
        {
          op: "render_set",
          set: setId,
          camera: cameraForRender,
          stills: [0, snapTime(set, set.duration / 2)],
        }
      )
      if (!res.ok) setError(res.note ?? "")
      else if (res.video?.file) setRendered({ file: res.video.file })
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setRendering(false)
    }
  }

  const sel = set ? findItem(set, selected) : null
  const at = set ? snapTime(set, time) : 0
  const selKeys = sel ? keysOf(sel.item) : undefined
  const keyHere = selKeys?.find((k) => k.t === at)

  /** Set a key on the selected camera/actor at the playhead, from what it
   *  shows now — then fields edit that key. */
  const keyNow = () => {
    if (!sel || !set) return
    const s = sampleKeys(sel.item as SetCamera, time)
    if (sel.kind === "camera" && s) {
      void apply([
        {
          type: "key.set",
          id: sel.item.id,
          key: { t: at, position: s.position, target: s.target },
        },
      ])
    } else if (sel.kind === "actor") {
      const a = sel.item as { position: Vec3; rotation: Vec3 }
      void apply([
        {
          type: "key.set",
          id: sel.item.id,
          key: {
            t: at,
            position: s?.position ?? a.position,
            yaw: s?.yaw ?? a.rotation[1],
          },
        },
      ])
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/50 px-2 py-1">
        <Clapperboard className="h-3.5 w-3.5 text-muted-foreground" />
        <select
          className="h-6 rounded border border-border bg-background px-1"
          value={setId ?? ""}
          onChange={(e) => {
            setSetId(e.target.value || null)
            setSelected(null)
            setView("free")
            setRendered(null)
          }}
          aria-label={t("set")}
        >
          {sets.length === 0 && <option value="">{t("noSet")}</option>}
          {sets.map((s) => (
            <option key={s.id} value={s.id} disabled={Boolean(s.error)}>
              {s.name ?? s.id}
            </option>
          ))}
        </select>
        <input
          className="h-6 w-28 rounded border border-border bg-background px-1"
          placeholder={t("newPlaceholder")}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
        />
        <button
          type="button"
          className="studio-film-btn"
          onClick={() => void create()}
          disabled={busy || !newName.trim()}
        >
          <Plus className="h-3 w-3" />
          {t("create")}
        </button>
        {set && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
            <select
              className="h-6 rounded border border-border bg-background px-1"
              value={view}
              onChange={(e) => setView(e.target.value)}
              aria-label={t("view")}
            >
              <option value="free">{t("freeView")}</option>
              {set.cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {t("through", { name: c.name ?? c.id })}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={cn("studio-film-btn", mode === "translate" && "is-on")}
              onClick={() => setMode("translate")}
              title={t("move")}
            >
              <Move3d className="h-3 w-3" />
            </button>
            <button
              type="button"
              className={cn("studio-film-btn", mode === "rotate" && "is-on")}
              onClick={() => setMode("rotate")}
              title={t("rotate")}
            >
              <Rotate3d className="h-3 w-3" />
            </button>
            <span className="flex-1" />
            <button
              type="button"
              className="studio-film-btn is-primary"
              onClick={() => void render()}
              disabled={rendering || !cameraForRender}
              title={t("renderHint")}
            >
              <Clapperboard className="h-3 w-3" />
              {rendering
                ? t("rendering")
                : t("render", { camera: cameraForRender ?? "" })}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="shrink-0 whitespace-pre-wrap border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
          {error}
        </div>
      )}

      {!set ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 bg-[#16181d]">
              {base && (
                <iframe
                  ref={frame}
                  title={t("set")}
                  className="absolute inset-0 h-full w-full border-0"
                  src={`${base}__codeg/viewer/set.html`}
                  onLoad={() => {
                    ready.current = false
                  }}
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border/50 px-2 py-1">
              <button
                type="button"
                className="studio-film-btn"
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? t("pause") : t("play")}
              >
                {playing ? (
                  <Pause className="h-3 w-3" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </button>
              <div className="relative flex-1">
                <input
                  type="range"
                  className="w-full"
                  min={0}
                  max={set.duration}
                  step={1 / set.fps}
                  value={time}
                  onChange={(e) => {
                    setPlaying(false)
                    setTime(Number(e.target.value))
                  }}
                  aria-label={t("time")}
                />
                {selKeys?.map((k) => (
                  <button
                    key={k.t}
                    type="button"
                    className={cn(
                      "absolute -top-1 h-2 w-2 -translate-x-1/2 rounded-full",
                      k.t === at ? "bg-amber-400" : "bg-amber-600/70"
                    )}
                    style={{ left: `${(k.t / set.duration) * 100}%` }}
                    onClick={() => {
                      setPlaying(false)
                      setTime(k.t)
                    }}
                    title={`${k.t}s`}
                  />
                ))}
              </div>
              <span className="w-24 text-right tabular-nums text-muted-foreground">
                {at.toFixed(2)}s / {set.duration}s
              </span>
            </div>
          </div>

          <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border/50">
            <section className="border-b border-border/50 p-2">
              <div className="mb-1 flex flex-wrap gap-1">
                <AddModel
                  label={t("addProp")}
                  models={models}
                  onPick={(asset) =>
                    void apply([addCommand(set, "prop", asset)])
                  }
                />
                <AddModel
                  label={t("addActor")}
                  models={models}
                  onPick={(asset) =>
                    void apply([addCommand(set, "actor", asset)])
                  }
                />
                <button
                  type="button"
                  className="studio-film-btn"
                  onClick={() => void apply([addCommand(set, "light")])}
                >
                  <Plus className="h-3 w-3" />
                  {t("addLight")}
                </button>
                <button
                  type="button"
                  className="studio-film-btn"
                  onClick={() => void apply([addCommand(set, "camera")])}
                >
                  <Plus className="h-3 w-3" />
                  {t("addCamera")}
                </button>
              </div>
              <ul>
                {(["prop", "actor", "light", "camera"] as SetKind[]).flatMap(
                  (kind) =>
                    (
                      set[`${kind}s` as "props"] as {
                        id: string
                        name?: string
                      }[]
                    ).map((item) => {
                      const Icon = KIND_ICON[kind]
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-primary/8",
                              selected === item.id &&
                                "bg-primary/10 text-primary"
                            )}
                            onClick={() => setSelected(item.id)}
                          >
                            <Icon className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {item.name ?? item.id}
                            </span>
                          </button>
                        </li>
                      )
                    })
                )}
              </ul>
            </section>

            {sel && (
              <Inspector
                key={`${at}@${JSON.stringify(sel.item)}`}
                set={set}
                kind={sel.kind}
                item={sel.item as unknown as Record<string, unknown>}
                at={at}
                time={time}
                keyHere={Boolean(keyHere)}
                models={models}
                onApply={(cmds) => void apply(cmds)}
                onKeyNow={keyNow}
                onDeleted={() => setSelected(null)}
              />
            )}

            {outcome && outcome.issues.length > 0 && (
              <section className="border-b border-border/50 p-2">
                <div className="mb-1 font-medium">{t("issues")}</div>
                <ul className="list-disc space-y-0.5 pl-4 text-amber-600 dark:text-amber-400">
                  {outcome.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </section>
            )}

            {rendered && base && outcome && (
              <section className="p-2">
                <div className="mb-1 font-medium">{t("lastRender")}</div>
                <video
                  className="w-full rounded"
                  src={`${base}${outcome.assets_dir}/${rendered.file}`}
                  controls
                  muted
                  loop
                  playsInline
                />
              </section>
            )}
            <p className="mt-auto p-2 text-muted-foreground">
              {t("hint", { file: outcome?.path ?? "" })}
            </p>
          </aside>
        </div>
      )}
    </div>
  )
}

function AddModel({
  label,
  models,
  onPick,
}: {
  label: string
  models: StudioAsset[]
  onPick: (asset: string) => void
}) {
  return (
    <select
      className="studio-film-btn"
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      aria-label={label}
    >
      <option value="">+ {label}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
          {m.bones ? " 🦴" : ""}
        </option>
      ))}
    </select>
  )
}

/** Number fields that send one command when left. */
function Vec({
  label,
  value,
  onCommit,
}: {
  label: string
  value: Vec3
  onCommit: (v: Vec3) => void
}) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr_1fr_1fr] items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      {value.map((n, i) => (
        <input
          key={i}
          type="number"
          step={0.1}
          defaultValue={Math.round(n * 1000) / 1000}
          className="h-6 w-full min-w-0 rounded border border-border bg-background px-1"
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v) || v === n) return
            const next = [...value] as Vec3
            next[i] = v
            onCommit(next)
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      ))}
    </label>
  )
}

function Num({
  label,
  value,
  step = 1,
  onCommit,
}: {
  label: string
  value: number | undefined
  step?: number
  onCommit: (v: number | null) => void
}) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        step={step}
        defaultValue={value ?? ""}
        className="h-6 w-full rounded border border-border bg-background px-1"
        onBlur={(e) => {
          const raw = e.target.value.trim()
          const v = raw === "" ? null : Number(raw)
          if (v === (value ?? null) || (v !== null && !Number.isFinite(v)))
            return
          onCommit(v)
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </label>
  )
}

function Inspector({
  set,
  kind,
  item,
  at,
  time,
  keyHere,
  models,
  onApply,
  onKeyNow,
  onDeleted,
}: {
  set: FilmSet
  kind: SetKind
  item: Record<string, unknown>
  at: number
  time: number
  keyHere: boolean
  models: StudioAsset[]
  onApply: (commands: object[]) => void
  onKeyNow: () => void
  onDeleted: () => void
}) {
  const t = useTranslations("StudioSet")
  const id = item.id as string
  const update = (patch: object) => onApply([{ type: "update", id, patch }])
  const keyed =
    kind === "camera" || (kind === "actor" && Array.isArray(item.keys))
  const s = keyed ? sampleKeys(item as never, time) : null
  const setKey = (key: object) =>
    onApply([{ type: "key.set", id, key: { t: at, ...key } }])
  const keys = (item.keys as { t: number }[] | undefined) ?? []

  return (
    <section className="space-y-1 border-b border-border/50 p-2">
      <div className="flex items-center gap-1 font-medium">
        <span className="flex-1 truncate">{id}</span>
        <button
          type="button"
          className="studio-film-btn"
          onClick={() => {
            onApply([{ type: "remove", id }])
            onDeleted()
          }}
          title={t("delete")}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {(kind === "prop" || kind === "actor") && (
        <>
          <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
            <span className="text-muted-foreground">{t("asset")}</span>
            <select
              className="h-6 rounded border border-border bg-background px-1"
              value={item.asset as string}
              onChange={(e) => update({ asset: e.target.value })}
            >
              {!models.some((m) => m.id === item.asset) && (
                <option value={item.asset as string}>
                  {item.asset as string}
                </option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
          {keyed && s ? (
            keyHere ? (
              <>
                <Vec
                  label={t("position")}
                  value={s.position}
                  onCommit={(position) => setKey({ position })}
                />
                <Num
                  label={t("yaw")}
                  value={Math.round(s.yaw * 100) / 100}
                  onCommit={(yaw) => yaw !== null && setKey({ yaw })}
                />
              </>
            ) : null
          ) : (
            <Vec
              label={t("position")}
              value={item.position as Vec3}
              onCommit={(position) => update({ position })}
            />
          )}
          <Vec
            label={t("rotation")}
            value={item.rotation as Vec3}
            onCommit={(rotation) => update({ rotation })}
          />
          <Num
            label={t("height")}
            value={item.height as number | undefined}
            step={0.1}
            onCommit={(height) => update({ height })}
          />
          {kind === "actor" && (
            <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
              <span className="text-muted-foreground">{t("motion")}</span>
              <select
                className="h-6 rounded border border-border bg-background px-1"
                value={item.motion as string}
                onChange={(e) => update({ motion: e.target.value })}
              >
                <option value="still">{t("motionStill")}</option>
                <option value="walk">{t("motionWalk")}</option>
              </select>
            </label>
          )}
        </>
      )}

      {kind === "light" && (
        <>
          <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
            <span className="text-muted-foreground">{t("lightType")}</span>
            <select
              className="h-6 rounded border border-border bg-background px-1"
              value={item.type as string}
              onChange={(e) => update({ type: e.target.value })}
            >
              {["area", "point", "spot", "sun"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <Vec
            label={t("position")}
            value={item.position as Vec3}
            onCommit={(position) => update({ position })}
          />
          <Vec
            label={t("target")}
            value={item.target as Vec3}
            onCommit={(target) => update({ target })}
          />
          <Num
            label={t("power")}
            value={item.power as number}
            step={item.type === "sun" ? 0.5 : 50}
            onCommit={(power) => power !== null && update({ power })}
          />
          <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
            <span className="text-muted-foreground">{t("color")}</span>
            <input
              type="color"
              defaultValue={item.color as string}
              className="h-6 w-full"
              onBlur={(e) =>
                e.target.value !== item.color &&
                update({ color: e.target.value })
              }
            />
          </label>
        </>
      )}

      {kind === "camera" && s && (
        <>
          <Num
            label={t("lens")}
            value={item.lens as number}
            onCommit={(lens) => lens !== null && update({ lens })}
          />
          {keyHere ? (
            <>
              <Vec
                label={t("position")}
                value={s.position}
                onCommit={(position) => setKey({ position })}
              />
              <Vec
                label={t("target")}
                value={s.target ?? [0, 0, 0]}
                onCommit={(target) => setKey({ target })}
              />
            </>
          ) : null}
          <label className="grid grid-cols-[4.5rem_1fr] items-center gap-1">
            <span className="text-muted-foreground">{t("ease")}</span>
            <select
              className="h-6 rounded border border-border bg-background px-1"
              value={item.ease as string}
              onChange={(e) => update({ ease: e.target.value })}
            >
              <option value="smooth">{t("easeSmooth")}</option>
              <option value="linear">{t("easeLinear")}</option>
            </select>
          </label>
        </>
      )}

      {(kind === "camera" || kind === "actor") && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <span className="text-muted-foreground">
            {t("keys", { count: keys.length, t: at.toFixed(2) })}
          </span>
          {keyHere ? (
            keys.length > (kind === "camera" ? 1 : 0) && (
              <button
                type="button"
                className="studio-film-btn"
                onClick={() => onApply([{ type: "key.remove", id, t: at }])}
              >
                {t("removeKey")}
              </button>
            )
          ) : (
            <button
              type="button"
              className="studio-film-btn"
              onClick={onKeyNow}
            >
              {t("addKey")}
            </button>
          )}
        </div>
      )}
      {set && keyed && !keyHere && (
        <p className="text-muted-foreground">{t("keyHint")}</p>
      )}
    </section>
  )
}
