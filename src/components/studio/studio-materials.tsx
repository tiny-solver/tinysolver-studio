"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Box, ImageIcon, Plug, RefreshCw, Sparkles } from "lucide-react"
import { studioRun } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import type { StudioAsset, StudioAssetList, StudioOp } from "@/lib/types"

/** Defaults for "Make 3D": a game-sized mesh (1만 면 holds its shape thanks
 *  to the normal map) with a texture that stays within the 2048 web limit. */
const LIFT_3D = { target_faces: 10000, texture_size: 2048 } as const

interface StudioMaterialsProps {
  root: string
  /** `<origin>/api/content-preview/<id>/` — serves the project folder, so
   *  image thumbnails load straight from `assets/`. */
  previewBase: string | null
}

function formatBytes(n?: number): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The project's materials (`assets/manifest.json`) and the round trip to the
 * generator: draw from a prompt, lift an image into 3D, and see each result
 * land here with where it came from. Every button runs the same operation
 * the companion's `studio_*` MCP tools run, and the list follows the disk,
 * so an agent's import shows up here too.
 */
export function StudioMaterials({ root, previewBase }: StudioMaterialsProps) {
  const t = useTranslations("Studio.materials")
  const [list, setList] = useState<StudioAssetList | null>(null)
  const [error, setError] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [generatorDraft, setGeneratorDraft] = useState("")

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
      await run("image", { op: "generate_asset", kind: "image", prompt: text })
    )
      setPrompt("")
  }

  const assets = list?.assets ?? []
  const generator = list?.generator ?? null
  const busy = pending !== null

  return (
    <div className="studio-materials">
      <div className="studio-section-title">
        <h2>{t("title")}</h2>
        <button
          className="studio-icon-button"
          onClick={() => void refresh()}
          title={t("refresh")}
          aria-label={t("refresh")}
        >
          <RefreshCw size={13} />
        </button>
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

      {error && <p className="studio-materials-error">{error}</p>}

      {list && assets.length === 0 && (
        <div className="studio-empty-assets">{t("empty")}</div>
      )}
      <div className="studio-material-list">
        {assets.map((asset) => (
          <MaterialRow
            key={asset.id}
            asset={asset}
            src={
              previewBase && asset.kind === "image" && asset.exists
                ? `${previewBase}${assetsDir}/${asset.file}`
                : null
            }
            canLift={Boolean(generator) && asset.kind === "image"}
            lifting={pending === `3d:${asset.id}`}
            busy={busy}
            onLift={() =>
              void run(`3d:${asset.id}`, {
                op: "generate_asset",
                kind: "3d",
                from: asset.id,
                ...LIFT_3D,
              })
            }
          />
        ))}
      </div>
    </div>
  )
}

function MaterialRow({
  asset,
  src,
  canLift,
  lifting,
  busy,
  onLift,
}: {
  asset: StudioAsset
  src: string | null
  canLift: boolean
  lifting: boolean
  busy: boolean
  onLift: () => void
}) {
  const t = useTranslations("Studio.materials")
  const facts = [
    asset.kind === "model" ? "GLB" : null,
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    formatBytes(asset.bytes),
    asset.exists ? null : t("missing"),
  ].filter(Boolean)
  const source = asset.source
  const made = source
    ? [
        source.workflow,
        source.seed != null ? `seed ${source.seed}` : null,
        source.from ? t("from", { id: source.from }) : null,
        source.params?.target_faces
          ? t("faces", { count: source.params.target_faces })
          : null,
      ].filter(Boolean)
    : []
  return (
    <div className="studio-material-row">
      <div className="studio-material-thumb">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- served by the preview server, not a static asset
          <img src={src} alt={asset.id} loading="lazy" />
        ) : asset.kind === "model" ? (
          <Box size={18} />
        ) : (
          <ImageIcon size={18} />
        )}
      </div>
      <div className="studio-material-meta">
        <strong title={asset.file}>{asset.id}</strong>
        <span>{facts.join(" · ")}</span>
        {made.length > 0 && (
          <span title={source?.prompt}>{made.join(" · ")}</span>
        )}
        {canLift && (
          <button disabled={busy} onClick={onLift}>
            <Box size={12} />
            {lifting ? t("lifting") : t("make3d")}
          </button>
        )}
      </div>
    </div>
  )
}
