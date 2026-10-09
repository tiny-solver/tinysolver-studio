"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowRight,
  Box,
  Clapperboard,
  Gamepad2,
  ImageIcon,
  X,
} from "lucide-react"

import {
  createContentProject,
  getContentPreview,
  getHomeDirectory,
  loadFolderHistory,
  openFolderInWorkspace,
  readContentProject,
  studioRun,
} from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { previewBase } from "@/lib/studio/game-url"
import {
  newFlow,
  type FlowImageChoice,
  parseFlow,
  projectNameFor,
  type FlowGoal,
  type StudioFlow,
} from "@/lib/studio/flow"
import type { StudioAssetList } from "@/lib/types"
import { ImageChoiceSelect, useGeneratorOptions } from "./step-settings"

/** Where new projects go, under the home folder. */
const PROJECTS_DIR = "TinysolverStudio"
/** Last generator address used, so a new project is connected at once. */
export const GENERATOR_KEY = "tinysolver.studio.generator"

const GOAL_ICONS = {
  video: Clapperboard,
  model: Box,
  image: ImageIcon,
  scene: Gamepad2,
} as const

interface Recent {
  root: string
  name: string
  flow: StudioFlow | null
  thumbs: string[]
  generator: string | null
}

function rememberedGenerator(): string {
  try {
    return localStorage.getItem(GENERATOR_KEY) ?? ""
  } catch {
    return ""
  }
}

/** Recent content projects, newest first, with a few image thumbnails. */
async function loadRecent(limit = 6): Promise<Recent[]> {
  const history = await loadFolderHistory()
  const sorted = [...history].sort((a, b) =>
    b.last_opened_at.localeCompare(a.last_opened_at)
  )
  const out: Recent[] = []
  for (const entry of sorted) {
    if (out.length >= limit) break
    const manifest = await readContentProject(entry.path).catch(() => null)
    if (!manifest) continue
    const [flowRes, list, preview] = await Promise.all([
      studioRun<{ ok: boolean; flow?: unknown }>(entry.path, {
        op: "read_flow",
      }).catch(() => null),
      studioRun<StudioAssetList>(entry.path, { op: "list_assets" }).catch(
        () => null
      ),
      getContentPreview(entry.path).catch(() => null),
    ])
    const base = preview ? `${previewBase(preview)}/` : null
    const thumbs =
      base && list?.ok
        ? list.assets
            .filter((a) => a.exists && a.kind === "image")
            .slice(-3)
            .map((a) => `${base}${list.assets_dir}/${a.file}`)
        : []
    out.push({
      root: entry.path,
      name: manifest.name,
      flow: flowRes?.ok ? parseFlow(flowRes.flow) : null,
      thumbs,
      generator: manifest.generate?.url ?? null,
    })
  }
  return out
}

/**
 * "무엇을 만들까요?" — one prompt, what it should become, and whether it is a
 * character. Making scaffolds a content project under ~/TinysolverStudio,
 * connects the generator, writes the flow and opens the folder; the cards
 * take it from there.
 */
export function CreateStart({
  onCreated,
  onCancel,
}: {
  onCreated: (root: string, flow: StudioFlow) => void
  onCancel?: () => void
}) {
  const t = useTranslations("StudioHome")
  const [prompt, setPrompt] = useState("")
  const [goal, setGoal] = useState<FlowGoal>("video")
  const [character, setCharacter] = useState(false)
  const [generator, setGenerator] = useState("")
  const [recent, setRecent] = useState<Recent[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  /** Absent → the generator's default (집 GPU qwen-image-21-rgba). */
  const [image, setImage] = useState<FlowImageChoice | undefined>()
  const [home, setHome] = useState<string | null>(null)
  /** The generator the picker lists, settled on blur, not every keystroke. */
  const [listedFrom, setListedFrom] = useState(rememberedGenerator)
  const [options] = useGeneratorOptions(home, listedFrom)

  useEffect(() => {
    getHomeDirectory()
      .then(setHome)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    loadRecent()
      .then((list) => {
        if (cancelled) return
        setRecent(list)
        const g =
          rememberedGenerator() ||
          list.find((r) => r.generator)?.generator ||
          ""
        setGenerator((cur) => cur || g)
        setListedFrom((cur) => cur || g)
      })
      .catch(() => !cancelled && setRecent([]))
    return () => {
      cancelled = true
    }
  }, [])

  const make = async () => {
    const text = prompt.trim()
    if (!text) return
    setBusy(true)
    setError("")
    try {
      const home = await getHomeDirectory()
      const targetDir = joinFsPath(home, PROJECTS_DIR)
      const base = projectNameFor(text)
      let root = ""
      for (let n = 1; n < 50 && !root; n++) {
        try {
          root = await createContentProject({
            projectName: n === 1 ? base : `${base}-${n}`,
            targetDir,
            template: "web-three",
            outputs: ["game", "video"],
          })
        } catch (err) {
          if (extractAppCommandError(err)?.code !== "already_exists") throw err
        }
      }
      if (!root) throw new Error(t("errors.noFolder"))
      const url = generator.trim()
      if (url) {
        const res = await studioRun(root, { op: "connect_generator", url })
        if (res.ok) {
          try {
            localStorage.setItem(GENERATOR_KEY, url)
          } catch {
            // remembered for convenience only
          }
        }
      }
      const flow = newFlow(text, goal, character, new Date(), image)
      await studioRun(root, { op: "write_flow", flow })
      onCreated(root, flow)
      // Upserts the folder and opens a draft conversation in it, so the
      // drawer's agent works in the new project.
      await openFolderInWorkspace(root).catch(() => undefined)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const open = async (r: Recent) => {
    setError("")
    try {
      await openFolderInWorkspace(r.root)
      if (r.flow) onCreated(r.root, r.flow)
    } catch (err) {
      setError(toErrorMessage(err))
    }
  }

  return (
    <div className="studio-start">
      {onCancel && (
        <button
          className="studio-start-cancel"
          onClick={onCancel}
          aria-label={t("start.back")}
          title={t("start.back")}
        >
          <X size={16} />
        </button>
      )}
      <h1>{t("start.title")}</h1>
      <div className="studio-start-box">
        <textarea
          value={prompt}
          rows={3}
          autoFocus
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void make()
          }}
          placeholder={t("start.placeholder")}
          aria-label={t("start.title")}
        />
        <div className="studio-start-row">
          <div className="studio-start-chips" role="radiogroup">
            {(Object.keys(GOAL_ICONS) as FlowGoal[]).map((g) => {
              const Icon = GOAL_ICONS[g]
              return (
                <button
                  key={g}
                  role="radio"
                  aria-checked={goal === g}
                  className={goal === g ? "is-on" : undefined}
                  onClick={() => setGoal(g)}
                >
                  <Icon size={14} />
                  {t(`goal.${g}`)}
                </button>
              )
            })}
          </div>
          <label className="studio-start-character">
            <input
              type="checkbox"
              checked={character}
              onChange={(e) => setCharacter(e.target.checked)}
              disabled={goal === "image"}
            />
            {t("start.character")}
          </label>
          <ImageChoiceSelect
            className="studio-start-model"
            options={options}
            value={image}
            onChange={setImage}
          />
          <button
            className="studio-start-go"
            disabled={busy || !prompt.trim()}
            onClick={() => void make()}
          >
            {busy ? t("start.making") : t("start.make")}
            <ArrowRight size={14} />
          </button>
        </div>
        <p className="studio-start-hint">{t(`hint.${goal}`)}</p>
        <label className="studio-start-generator">
          <span>{t("start.generator")}</span>
          <input
            value={generator}
            onChange={(e) => setGenerator(e.target.value)}
            onBlur={() => setListedFrom(generator.trim())}
            placeholder="https://…"
          />
        </label>
        {error && <p className="studio-start-error">{error}</p>}
      </div>

      <section className="studio-start-recent">
        <h2>{t("recent.title")}</h2>
        {recent === null ? (
          <p className="studio-start-muted">{t("recent.loading")}</p>
        ) : recent.length === 0 ? (
          <p className="studio-start-muted">{t("recent.empty")}</p>
        ) : (
          <div className="studio-start-recent-grid">
            {recent.map((r) => (
              <button
                key={r.root}
                className="studio-start-project"
                onClick={() => void open(r)}
                title={r.root}
              >
                <div className="studio-start-thumbs">
                  {r.thumbs.length > 0 ? (
                    r.thumbs.map((src) => (
                      // eslint-disable-next-line @next/next/no-img-element -- served by the preview server
                      <img key={src} src={src} alt="" loading="lazy" />
                    ))
                  ) : (
                    <ImageIcon size={18} />
                  )}
                </div>
                <strong>{r.name}</strong>
                <span>
                  {r.flow
                    ? `${t(`goal.${r.flow.goal}`)} · ${r.flow.prompt}`
                    : t("recent.noFlow")}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
