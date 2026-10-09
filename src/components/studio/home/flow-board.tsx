"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Bone,
  Box,
  Camera,
  Check,
  Clapperboard,
  Film,
  ImageIcon,
  Loader2,
  MessageSquare,
  PersonStanding,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  SquarePen,
  TriangleAlert,
} from "lucide-react"

import { useWorkspaceContext } from "@/contexts/workspace-context"
import { getContentPreview, studioRun } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { previewBase } from "@/lib/studio/game-url"
import {
  choiceKey,
  DEFAULT_CAMERA,
  nextStep,
  planSteps,
  recordOf,
  stepOp,
  withoutStepsFrom,
  type FlowStepId,
  type StudioFlow,
} from "@/lib/studio/flow"
import type { StudioAsset, StudioAssetList } from "@/lib/types"
import {
  MadeWith,
  shownImageChoice,
  StepSettings,
  useGeneratorOptions,
} from "./step-settings"

/** Steps whose model and values can be picked on the card. */
const SETTABLE: FlowStepId[] = ["image", "model", "video"]

const STEP_ICONS = {
  image: ImageIcon,
  tpose: PersonStanding,
  model: Box,
  rig: Bone,
  camera: Camera,
  render: Clapperboard,
  video: Film,
} as const

/**
 * The step cards, left to right. Each card runs one operation (the same one
 * the material drawer's button and the matching MCP tool run), shows what it
 * made, can run again (which clears the cards after it) and opens the
 * editor where that material can be worked on by hand. Steps run on their
 * own one after another until one fails or needs input.
 */
export function FlowBoard({
  root,
  initial,
  folderId,
  onNew,
  onOpenChat,
}: {
  root: string
  initial: StudioFlow
  folderId: number | null
  onNew: () => void
  onOpenChat: () => void
}) {
  const t = useTranslations("StudioHome")
  const { openStudioPane } = useWorkspaceContext()
  const [flow, setFlow] = useState(initial)
  const [running, setRunning] = useState<FlowStepId | null>(null)
  const [auto, setAuto] = useState(true)
  const [assets, setAssets] = useState<Record<string, StudioAsset>>({})
  const [base, setBase] = useState<{
    files: string
    viewer: string
    assetsDir: string
  } | null>(null)
  const [error, setError] = useState("")
  const [settingsOf, setSettingsOf] = useState<FlowStepId | null>(null)
  const [options, reloadOptions] = useGeneratorOptions(root)
  const flowRef = useRef(flow)
  flowRef.current = flow

  const plan = planSteps(flow.goal, flow.character)

  const refreshAssets = useCallback(async () => {
    const list = await studioRun<StudioAssetList>(root, {
      op: "list_assets",
    }).catch(() => null)
    if (!list?.ok) return
    setAssets(Object.fromEntries(list.assets.map((a) => [a.id, a])))
    const info = await getContentPreview(root).catch(() => null)
    if (info) {
      const b = `${previewBase(info)}/`
      setBase({
        files: `${b}${list.assets_dir}/`,
        viewer: b,
        assetsDir: list.assets_dir,
      })
    }
  }, [root])

  useEffect(() => {
    void refreshAssets()
  }, [refreshAssets])

  const save = useCallback(
    async (next: StudioFlow) => {
      setFlow(next)
      const res = await studioRun(root, { op: "write_flow", flow: next })
      if (!res.ok) setError(res.note ?? "")
    },
    [root]
  )

  const runStep = useCallback(
    async (step: FlowStepId) => {
      const current = withoutStepsFrom(flowRef.current, step)
      const op = stepOp(step, current)
      if (!op) return
      setRunning(step)
      setError("")
      const started = Date.now()
      try {
        const outcome = await studioRun(root, op)
        const record = {
          ...recordOf(outcome),
          seconds: Math.round((Date.now() - started) / 1000),
        }
        const next = {
          ...current,
          steps: { ...current.steps, [step]: record },
        }
        await save(next)
        if (!outcome.ok) setAuto(false)
      } catch (err) {
        setError(toErrorMessage(err))
        setAuto(false)
      } finally {
        setRunning(null)
        void refreshAssets()
      }
    },
    [root, save, refreshAssets]
  )

  // One after another while `auto` is on.
  const upcoming = nextStep(flow)
  useEffect(() => {
    if (!auto || running || !upcoming) return
    if (flow.steps[upcoming]?.status === "failed") return
    if (!stepOp(upcoming, flow)) return
    void runStep(upcoming)
  }, [auto, running, upcoming, flow, runStep])

  const openEditor = () => {
    if (folderId != null) openStudioPane(folderId, root, flow.prompt)
  }

  const preview = (id: string | undefined) => {
    const a = id ? assets[id] : undefined
    if (!a || !base) return null
    const src = `${base.files}${a.file}`
    if (a.kind === "video")
      return (
        <video src={src} controls muted loop playsInline preload="metadata" />
      )
    if (a.kind === "model")
      return (
        <iframe
          title={a.id}
          src={`${base.viewer}__codeg/viewer/model.html?src=${encodeURIComponent(
            `../../${base.assetsDir}/${a.file}`
          )}`}
        />
      )
    // eslint-disable-next-line @next/next/no-img-element -- served by the preview server
    return <img src={src} alt={a.id} />
  }

  const cam = flow.camera ?? DEFAULT_CAMERA
  const done = plan.filter((s) => flow.steps[s]?.status === "done").length

  return (
    <div className="studio-flow">
      <header className="studio-flow-head">
        <div>
          <span className="studio-flow-goal">{t(`goal.${flow.goal}`)}</span>
          <h1 title={root}>{flow.prompt}</h1>
          <small>
            {t("flow.progress", { done, total: plan.length })} ·{" "}
            {root.split(/[\\/]/).pop()}
          </small>
        </div>
        <div className="studio-flow-actions">
          {!auto && upcoming && (
            <button onClick={() => setAuto(true)} disabled={!!running}>
              <Play size={14} />
              {t("flow.resume")}
            </button>
          )}
          <button onClick={openEditor} disabled={folderId == null}>
            <SquarePen size={14} />
            {t("flow.editor")}
          </button>
          <button onClick={onOpenChat}>
            <MessageSquare size={14} />
            {t("flow.chat")}
          </button>
          <button onClick={onNew}>
            <Plus size={14} />
            {t("flow.new")}
          </button>
        </div>
      </header>
      {error && <p className="studio-flow-error">{error}</p>}

      <ol className="studio-flow-cards">
        {plan.map((step, i) => {
          const rec = flow.steps[step]
          const Icon = STEP_ICONS[step]
          const isRunning = running === step
          const ready = !!stepOp(step, flow)
          const state = isRunning
            ? "running"
            : (rec?.status ?? (ready ? "ready" : "waiting"))
          // A still render shows its picture; everything else its material.
          const shownId =
            step === "camera"
              ? (rec?.stills?.[0] ?? rec?.material)
              : rec?.material
          const madeAsset = rec?.material ? assets[rec.material] : undefined
          // The picture was drawn with something other than what is set now.
          const made = madeAsset?.source
          const want = shownImageChoice(options, flow.options?.image)
          const changed =
            step === "image" &&
            rec?.status === "done" &&
            !!made &&
            !!want &&
            choiceKey(want) !==
              choiceKey({
                provider: made.provider ?? "comfyui",
                workflow: made.workflow,
                model: made.model,
              })
          return (
            <li key={step} className="studio-flow-card" data-state={state}>
              <div className="studio-flow-card-head">
                <span className="studio-flow-num">{i + 1}</span>
                <Icon size={15} />
                <strong>{t(`step.${step}.title`)}</strong>
                <span className="studio-flow-state">
                  {state === "running" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : state === "done" ? (
                    <Check size={13} />
                  ) : state === "failed" ? (
                    <TriangleAlert size={13} />
                  ) : null}
                  {t(`state.${state}`)}
                </span>
                {SETTABLE.includes(step) && (
                  <button
                    className="studio-flow-gear"
                    aria-expanded={settingsOf === step}
                    aria-label={t("options.open")}
                    title={t("options.open")}
                    onClick={() => {
                      // The generator may have been busy or off at first.
                      if (settingsOf !== step && options?.note_code)
                        reloadOptions()
                      setSettingsOf((s) => (s === step ? null : step))
                    }}
                  >
                    <SlidersHorizontal size={13} />
                  </button>
                )}
              </div>
              <div className="studio-flow-preview">
                {rec?.status === "done" ? (
                  preview(shownId)
                ) : isRunning ? (
                  <p>{t(`step.${step}.running`)}</p>
                ) : rec?.status === "failed" ? (
                  <p className="studio-flow-note">{rec.note}</p>
                ) : (
                  <p>{t(`step.${step}.hint`)}</p>
                )}
              </div>
              {rec?.status === "done" && step !== "camera" && (
                <MadeWith
                  asset={madeAsset}
                  options={options}
                  seconds={rec.seconds}
                />
              )}
              {changed && (
                <p className="studio-flow-changed">{t("options.changed")}</p>
              )}
              {settingsOf === step && (
                <StepSettings
                  step={step}
                  flow={flow}
                  options={options}
                  disabled={!!running}
                  onChange={(next) => void save(next)}
                />
              )}
              {(step === "camera" || step === "render") && (
                <div className="studio-flow-camera">
                  {(
                    [
                      ["yaw", -180, 180, 5],
                      ["pitch", -20, 60, 1],
                      ["cam_dist", 2, 12, 0.1],
                    ] as const
                  ).map(([key, min, max, stepBy]) => (
                    <label key={key}>
                      <span>{t(`camera.${key}`)}</span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={stepBy}
                        value={cam[key]}
                        disabled={!!running}
                        onChange={(e) =>
                          setFlow((f) => ({
                            ...f,
                            camera: {
                              ...(f.camera ?? DEFAULT_CAMERA),
                              [key]: Number(e.target.value),
                            },
                          }))
                        }
                        onPointerUp={() => void save(flowRef.current)}
                      />
                      <output>{cam[key]}</output>
                    </label>
                  ))}
                </div>
              )}
              {step === "video" && (
                <textarea
                  className="studio-flow-motion"
                  rows={3}
                  value={flow.motion ?? ""}
                  disabled={!!running}
                  onChange={(e) =>
                    setFlow((f) => ({ ...f, motion: e.target.value }))
                  }
                  onBlur={() => void save(flowRef.current)}
                  aria-label={t("step.video.motion")}
                  placeholder={t("step.video.motion")}
                />
              )}
              <div className="studio-flow-card-actions">
                <button
                  disabled={!!running || !ready}
                  onClick={() => {
                    setAuto(false)
                    void runStep(step)
                  }}
                >
                  {rec ? <RotateCcw size={12} /> : <Play size={12} />}
                  {rec ? t("card.again") : t("card.run")}
                </button>
                <button onClick={openEditor} disabled={folderId == null}>
                  <SquarePen size={12} />
                  {t("card.edit")}
                </button>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
