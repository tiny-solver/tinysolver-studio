"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Bone,
  Box,
  Clapperboard,
  FilePlus2,
  Film,
  Footprints,
  ImageIcon,
  PersonStanding,
  Plug,
  RefreshCw,
  Sparkles,
  SquarePlus,
  Upload,
  Video,
} from "lucide-react"
import { studioRun } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  StudioAsset,
  StudioAssetList,
  StudioFinding,
  StudioOp,
  StudioPreset,
} from "@/lib/types"

/** Defaults for "Make 3D": a game-sized mesh (1만 면 holds its shape thanks
 *  to the normal map) with a 1024 texture — a 2048 bake on the 24GB GPU
 *  takes 6+ minutes or runs out of memory (genai 10-09). */
const LIFT_3D = { target_faces: 10000, texture_size: 1024 } as const

/** Where uploads land under `assets/`. */
const UPLOAD_DIR = "uploads"

interface StudioMaterialsProps {
  root: string
  /** `<origin>/api/content-preview/<id>/` — serves the project folder, so
   *  thumbnails and the model preview load straight from `assets/`. */
  previewBase: string | null
  /** Put an image material into the open scene (declare it + add a sprite).
   *  Absent when no scene is open. */
  onPlace?: (asset: StudioAsset) => void
}

export function formatBytes(n?: number): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** `hero idle (1).PNG` → `hero-idle-1`: the material id an upload gets. */
export function idFromFileName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "")
  const folded = stem
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return folded || "material"
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * The project's materials (`assets/manifest.json`): upload, register files
 * put there by hand, preview (image or GLB), see what each is made of
 * (size · faces · texture · bytes) and where it came from, draw new ones
 * with the generator and lift images into 3D. Every button runs the same
 * operation the companion's `studio_*` MCP tools run, and the list follows
 * the disk, so an agent's import shows up here too.
 */
export function StudioMaterials({
  root,
  previewBase,
  onPlace,
}: StudioMaterialsProps) {
  const t = useTranslations("Studio.materials")
  const [list, setList] = useState<StudioAssetList | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [generatorDraft, setGeneratorDraft] = useState("")
  const [previewing, setPreviewing] = useState<StudioAsset | null>(null)
  /** "Where will this be used" — a preset id, or "" for none. Applies to
   *  what the buttons make next; each material keeps its own `use`. */
  const [useFor, setUseFor] = useState("")
  const tp = useTranslations("Studio.materials.presets")
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await studioRun<StudioAssetList>(root, {
        op: "list_assets",
      })
      if (result.ok) setList(result)
      else setError(result.note ?? "")
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The register and its files change on disk — from these buttons, an
  // agent's studio_import_asset, or a hand edit. Follow the watch stream.
  const assetsDir = list?.assets_dir ?? "assets"
  useEffect(() => {
    const store = getWorkspaceStateStore(root)
    const token = store.acquire("paths")
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = store.subscribeEnvelopes((envelope) => {
      const touched = envelope.changed_paths.some((rel) => {
        const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "")
        return norm.startsWith(`${assetsDir}/`) || norm === "codeg-project.json"
      })
      if (!touched) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
      store.release(token)
    }
  }, [root, assetsDir, refresh])

  const run = async (key: string, op: StudioOp) => {
    setPending(key)
    setError("")
    try {
      const result = await studioRun(root, op)
      if (!result.ok) setError(result.note ?? "")
      await refresh()
      return result.ok
    } catch (reason) {
      setError(toErrorMessage(reason))
      return false
    } finally {
      setPending(null)
    }
  }

  const connect = async () => {
    const url = generatorDraft.trim()
    if (!url) return
    if (await run("connect", { op: "connect_generator", url }))
      setGeneratorDraft("")
  }

  const generateImage = async () => {
    const text = prompt.trim()
    if (!text) return
    if (
      await run("image", {
        op: "generate_asset",
        kind: "image",
        prompt: text,
        ...(useFor ? { use: useFor } : {}),
      })
    )
      setPrompt("")
  }

  const upload = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      let url: string
      try {
        url = await readAsDataUrl(file)
      } catch (reason) {
        setError(toErrorMessage(reason))
        continue
      }
      // GLB has no registered mime in most browsers; name the type so the
      // backend picks the right extension.
      if (/\.glb$/i.test(file.name))
        url = url.replace(/^data:[^;]*;/, "data:model/gltf-binary;")
      await run(`upload:${file.name}`, {
        op: "import_asset",
        url,
        id: idFromFileName(file.name),
        dir: UPLOAD_DIR,
      })
    }
  }

  const fileUrl = (file: string) =>
    previewBase ? `${previewBase}${assetsDir}/${file}` : null
  const modelViewerUrl = (file: string) =>
    previewBase
      ? `${previewBase}__codeg/viewer/model.html?src=${encodeURIComponent(
          `../../${assetsDir}/${file}`
        )}`
      : null

  const presets: StudioPreset[] = list?.presets ?? []
  const preset = presets.find((p) => p.id === useFor)
  const presetLabel = (id: string) => tp(id as "web-ar")
  const renderUseSelect = (
    value: string,
    onChange: (next: string) => void,
    label: string
  ) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      disabled={busy}
    >
      <option value="">{t("useNone")}</option>
      {presets.map((p) => (
        <option key={p.id} value={p.id}>
          {presetLabel(p.id)}
        </option>
      ))}
    </select>
  )

  /** The next steps a material can take — each one is the operation the
   *  matching MCP tool runs (generate_asset · render_asset). */
  const materialActions = (asset: StudioAsset): MaterialAction[] => {
    if (!asset.exists) return []
    const out: MaterialAction[] = []
    const step = (
      key: string,
      icon: MaterialAction["icon"],
      label: string,
      busyLabel: string,
      op: StudioOp
    ) => {
      const id = `${key}:${asset.id}`
      out.push({
        key,
        icon,
        label: pending === id ? busyLabel : label,
        onClick: () => void run(id, op),
      })
    }
    if (asset.kind === "image" && generator) {
      step("3d", "box", t("make3d"), t("lifting"), {
        op: "generate_asset",
        kind: "3d",
        from: asset.id,
        ...(useFor ? { use: useFor } : LIFT_3D),
      })
      step("tpose", "tpose", t("tpose"), t("tposing"), {
        op: "generate_asset",
        kind: "tpose",
        from: asset.id,
      })
      const motion = prompt.trim()
      out.push({
        key: "video",
        icon: "video",
        label: pending === `video:${asset.id}` ? t("videoing") : t("toVideo"),
        title: t("toVideoHint"),
        onClick: () => {
          if (!motion) {
            setError(t("needMotion"))
            return
          }
          void run(`video:${asset.id}`, {
            op: "generate_asset",
            kind: "video",
            from: asset.id,
            prompt: motion,
          }).then((ok) => {
            if (ok) setPrompt("")
          })
        },
      })
    }
    if (asset.kind === "model") {
      step("render", "render", t("render"), t("rendering"), {
        op: "render_asset",
        from: asset.id,
      })
      if (typeof asset.bones === "number") {
        step("walk", "walk", t("walk"), t("rendering"), {
          op: "render_asset",
          from: asset.id,
          mode: "walk",
        })
      } else if (generator) {
        step("rig", "rig", t("rig"), t("rigging"), {
          op: "generate_asset",
          kind: "rig",
          from: asset.id,
        })
      }
    }
    return out
  }

  const assets = list?.assets ?? []
  const loose = list?.unregistered ?? []
  const generator = list?.generator ?? null
  const busy = pending !== null

  return (
    <div className="studio-materials">
      <div className="studio-section-title">
        <h2>
          {t("title")} <span>{assets.length}</span>
        </h2>
        <div className="studio-materials-tools">
          <button
            className="studio-icon-button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            title={t("upload")}
            aria-label={t("upload")}
          >
            <Upload size={13} />
          </button>
          <button
            className="studio-icon-button"
            onClick={() => void refresh()}
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,.glb,.gltf"
          onChange={(e) => {
            void upload(e.target.files)
            e.target.value = ""
          }}
        />
      </div>

      {list && !generator ? (
        <div className="studio-materials-connect">
          <p>{t("noGenerator")}</p>
          <div>
            <input
              value={generatorDraft}
              onChange={(e) => setGeneratorDraft(e.target.value)}
              placeholder="https://…"
              aria-label={t("generatorUrl")}
            />
            <button disabled={busy} onClick={() => void connect()}>
              <Plug size={13} />
              {t("connect")}
            </button>
          </div>
        </div>
      ) : (
        generator && (
          <div className="studio-materials-generate">
            <small title={generator}>
              {t("generator")} · {generator.replace(/^https?:\/\//, "")}
            </small>
            <label className="studio-materials-use">
              <span>{t("use")}</span>
              {renderUseSelect(useFor, setUseFor, t("use"))}
            </label>
            <small>
              {preset
                ? t("useHint", {
                    faces: preset.target_faces.toLocaleString(),
                    texture: preset.texture_size,
                  })
                : t("useHintNone", {
                    faces: LIFT_3D.target_faces.toLocaleString(),
                    texture: LIFT_3D.texture_size,
                  })}
            </small>
            <textarea
              value={prompt}
              rows={2}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("promptPlaceholder")}
              aria-label={t("prompt")}
            />
            <button
              disabled={busy || !prompt.trim()}
              onClick={() => void generateImage()}
            >
              <Sparkles size={13} />
              {pending === "image" ? t("generating") : t("generateImage")}
            </button>
          </div>
        )
      )}

      {pending?.startsWith("upload:") && (
        <p>{t("uploading", { name: pending.slice(7) })}</p>
      )}
      {error && <p className="studio-materials-error">{error}</p>}

      {list && assets.length === 0 && loose.length === 0 && (
        <div className="studio-empty-assets">{t("empty")}</div>
      )}
      <div className="studio-material-list">
        {assets.map((asset) => (
          <MaterialRow
            key={asset.id}
            asset={asset}
            src={
              asset.kind === "image" && asset.exists
                ? fileUrl(asset.file)
                : null
            }
            onPreview={
              asset.exists && previewBase
                ? () => setPreviewing(asset)
                : undefined
            }
            onPlace={
              onPlace &&
              asset.exists &&
              (asset.kind === "model" ||
                (asset.kind === "image" && asset.width && asset.height))
                ? () => onPlace(asset)
                : undefined
            }
            video={
              asset.kind === "video" && asset.exists
                ? fileUrl(asset.file)
                : null
            }
            actions={materialActions(asset)}
            busy={busy}
          />
        ))}
      </div>

      {loose.length > 0 && (
        <div className="studio-materials-loose">
          <p>{t("unregistered")}</p>
          {loose.map((file) => (
            <div key={file} className="studio-material-loose-row">
              <span title={file}>{file}</span>
              <button
                disabled={busy}
                onClick={() =>
                  void run(`register:${file}`, { op: "import_asset", file })
                }
              >
                <FilePlus2 size={12} />
                {t("register")}
              </button>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={previewing !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null)
        }}
      >
        <DialogContent className="studio-material-preview">
          {previewing && (
            <>
              <DialogTitle>{previewing.id}</DialogTitle>
              <DialogDescription>
                {previewing.file} · {materialFacts(previewing, t).join(" · ")}
              </DialogDescription>
              <label className="studio-materials-use">
                <span>{t("use")}</span>
                {renderUseSelect(
                  previewing.use ?? "",
                  (next) => {
                    void run(`use:${previewing.id}`, {
                      op: "update_asset",
                      id: previewing.id,
                      use: next || null,
                    }).then(() =>
                      setPreviewing((p) =>
                        p ? { ...p, use: next || undefined } : p
                      )
                    )
                  },
                  t("use")
                )}
              </label>
              <Findings
                findings={assets.find((a) => a.id === previewing.id)?.check}
              />
              <div className="studio-material-preview-stage">
                {previewing.kind === "model" ? (
                  <iframe
                    title={previewing.id}
                    src={modelViewerUrl(previewing.file) ?? undefined}
                  />
                ) : previewing.kind === "video" ? (
                  <video
                    src={fileUrl(previewing.file) ?? undefined}
                    controls
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- served by the preview server, not a static asset
                  <img
                    src={fileUrl(previewing.file) ?? undefined}
                    alt={previewing.id}
                  />
                )}
              </div>
              {previewing.source && (
                <dl className="studio-material-source">
                  {(
                    [
                      ["workflow", previewing.source.workflow],
                      ["prompt", previewing.source.prompt],
                      ["seed", previewing.source.seed],
                      ["from", previewing.source.from],
                    ] as const
                  )
                    .filter(([, v]) => v != null && v !== "")
                    .map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

type Translate = (
  key: "tris" | "texture" | "missing" | "seconds" | "bones",
  values?: Record<string, string | number>
) => string

/** The numbers a material is judged by: kind, pixel size or faces and
 *  texture (or length for a clip), bytes. */
export function materialFacts(asset: StudioAsset, t: Translate): string[] {
  const params = asset.source?.params as
    | { width?: number; height?: number; frames?: number }
    | undefined
  const facts: (string | null)[] =
    asset.kind === "video"
      ? [
          asset.file.split(".").pop()?.toUpperCase() ?? null,
          params?.width && params?.height
            ? `${params.width}×${params.height}`
            : null,
          params?.frames
            ? `${(params.frames / 24).toFixed(1)} ${t("seconds")}`
            : null,
        ]
      : asset.kind === "model"
        ? [
            "GLB",
            typeof asset.triangles === "number"
              ? t("tris", { count: asset.triangles.toLocaleString() })
              : null,
            typeof asset.texture_max === "number"
              ? t("texture", { size: asset.texture_max })
              : null,
            typeof asset.bones === "number"
              ? t("bones", { count: asset.bones })
              : null,
          ]
        : [
            asset.width && asset.height
              ? `${asset.width}×${asset.height}`
              : null,
          ]
  facts.push(formatBytes(asset.bytes) || null)
  if (!asset.exists) facts.push(t("missing"))
  return facts.filter((f): f is string => Boolean(f))
}

interface MaterialAction {
  key: string
  icon: "box" | "tpose" | "video" | "render" | "walk" | "rig"
  label: string
  title?: string
  onClick: () => void
}

const ACTION_ICONS = {
  box: Box,
  tpose: PersonStanding,
  video: Film,
  render: Clapperboard,
  walk: Footprints,
  rig: Bone,
} as const

function MaterialRow({
  asset,
  src,
  video,
  onPreview,
  onPlace,
  actions,
  busy,
}: {
  asset: StudioAsset
  src: string | null
  /** A clip's URL — its first frame is the thumbnail. */
  video: string | null
  onPreview?: () => void
  onPlace?: () => void
  actions: MaterialAction[]
  busy: boolean
}) {
  const t = useTranslations("Studio.materials")
  const tp = useTranslations("Studio.materials.presets")
  const source = asset.source
  const made = source
    ? [
        source.workflow,
        source.seed != null ? `seed ${source.seed}` : null,
        source.from ? t("from", { id: source.from }) : null,
      ].filter(Boolean)
    : []
  return (
    <div className="studio-material-row">
      <button
        className="studio-material-thumb"
        onClick={onPreview}
        disabled={!onPreview}
        title={t("preview")}
        aria-label={t("preview")}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by the preview server, not a static asset
          <img src={src} alt={asset.id} loading="lazy" />
        ) : video ? (
          // `#t=0.1` makes the browser paint a frame instead of a blank box.
          <video src={`${video}#t=0.1`} muted preload="metadata" playsInline />
        ) : asset.kind === "model" ? (
          <Box size={18} />
        ) : asset.kind === "video" ? (
          <Video size={18} />
        ) : (
          <ImageIcon size={18} />
        )}
      </button>
      <div className="studio-material-meta">
        <strong title={asset.file}>{asset.id}</strong>
        <span>{materialFacts(asset, t).join(" · ")}</span>
        {made.length > 0 && (
          <span title={source?.prompt}>{made.join(" · ")}</span>
        )}
        {asset.use && (
          <span className="studio-material-use">
            {tp(asset.use as "web-ar")}
          </span>
        )}
        <Findings findings={asset.check} />
        {(onPlace || actions.length > 0) && (
          <div className="studio-material-actions">
            {onPlace && (
              <button disabled={busy} onClick={onPlace}>
                <SquarePlus size={12} />
                {t("place")}
              </button>
            )}
            {actions.map((a) => {
              const Icon = ACTION_ICONS[a.icon]
              return (
                <button
                  key={a.key}
                  disabled={busy}
                  onClick={a.onClick}
                  title={a.title}
                >
                  <Icon size={12} />
                  {a.label}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** What the material breaks for its `use` (see `studio_presets.rs`). */
function Findings({ findings }: { findings?: StudioFinding[] }) {
  const tc = useTranslations("Studio.materials.check")
  if (!findings?.length) return null
  return (
    <ul className="studio-material-check">
      {findings.map((f) => {
        const mb = f.code === "bytes_above"
        const values = {
          value: mb
            ? (f.value / 1024 / 1024).toFixed(1)
            : f.value.toLocaleString(),
          limit: mb
            ? Math.round(f.limit / 1024 / 1024)
            : f.limit.toLocaleString(),
        }
        return (
          <li key={f.code} className={`is-${f.level}`} title={f.message}>
            {tc.has(f.code as "tris_above")
              ? tc(f.code as "tris_above", values)
              : f.message}
          </li>
        )
      })}
    </ul>
  )
}
