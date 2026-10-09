"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { studioRun } from "@/lib/api"
import {
  choiceKey,
  imageChoiceOf,
  modelChoice,
  withOption,
  type FlowImageChoice,
  type FlowStepId,
  type StudioFlow,
} from "@/lib/studio/flow"
import type {
  StudioAsset,
  StudioGeneratorOptions,
  StudioImageChoice,
} from "@/lib/types"

/** What the generator offers, for the project at `root` (or the generator
 *  at `url`, before there is a project). `null` while loading. */
export function useGeneratorOptions(
  root: string | null,
  url?: string
): [StudioGeneratorOptions | null, () => void] {
  const [options, setOptions] = useState<StudioGeneratorOptions | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!root) return
    let cancelled = false
    studioRun<StudioGeneratorOptions>(root, {
      op: "generator_options",
      ...(url ? { url } : {}),
    })
      .then((o) => !cancelled && setOptions(o.ok ? o : null))
      .catch(() => !cancelled && setOptions(null))
    return () => {
      cancelled = true
    }
  }, [root, url, tick])
  return [options, () => setTick((n) => n + 1)]
}

/** The picture choice the image step uses: the flow's, else the default. */
export function shownImageChoice(
  options: StudioGeneratorOptions | null,
  chosen: FlowImageChoice | undefined
): StudioImageChoice | undefined {
  const want = chosen ?? options?.defaults.image
  if (!want) return undefined
  return options?.image.find((c) => choiceKey(c) === choiceKey(want))
}

/** "무료 · 생성기 GPU" · "구독 · ≈120초" · "종량 ≈$0.034/장 · ≈11초". */
export function useCostLabel() {
  const t = useTranslations("StudioHome.options")
  return (c: Pick<StudioImageChoice, "billing" | "usd" | "seconds">) =>
    [
      t(`billing.${c.billing}`),
      c.usd != null ? t("usd", { usd: c.usd }) : null,
      c.seconds != null ? t("seconds", { seconds: c.seconds }) : null,
    ]
      .filter(Boolean)
      .join(" · ")
}

/** A select over the picture choices, grouped free → subscription → metered. */
export function ImageChoiceSelect({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: StudioGeneratorOptions | null
  value: FlowImageChoice | undefined
  onChange: (next: FlowImageChoice) => void
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("StudioHome.options")
  const cost = useCostLabel()
  const list = options?.image ?? []
  const current = shownImageChoice(options, value)
  // A choice the generator does not list (saved earlier, or the default
  // while the generator is off) still shows as what will run.
  const want: FlowImageChoice | undefined = value ?? options?.defaults.image
  const orphan =
    want && !current
      ? {
          key: choiceKey(want),
          label: want.workflow ?? want.model ?? want.provider,
        }
      : null
  const groups = (["local", "subscription", "metered"] as const)
    .map((billing) => ({
      billing,
      items: list.filter((c) => c.billing === billing),
    }))
    .filter((g) => g.items.length > 0)
  return (
    <select
      className={className}
      value={orphan?.key ?? (current ? choiceKey(current) : "")}
      disabled={disabled || list.length === 0}
      aria-label={t("image")}
      onChange={(e) => {
        const c = list.find((x) => choiceKey(x) === e.target.value)
        if (c) onChange(imageChoiceOf(c))
      }}
    >
      {list.length === 0 && <option value="">{t("loading")}</option>}
      {orphan && <option value={orphan.key}>{orphan.label}</option>}
      {groups.map((g) => (
        <optgroup key={g.billing} label={t(`group.${g.billing}`)}>
          {g.items.map((c) => (
            <option key={choiceKey(c)} value={choiceKey(c)}>
              {c.label}
              {c.transparent ? ` · ${t("transparent")}` : ""} — {cost(c)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

/** The settings a step card opens: the model and the values it runs with.
 *  Changing one is saved at once; "다시 하기" then runs with it. */
export function StepSettings({
  step,
  flow,
  options,
  disabled,
  onChange,
}: {
  step: FlowStepId
  flow: StudioFlow
  options: StudioGeneratorOptions | null
  disabled: boolean
  onChange: (next: StudioFlow) => void
}) {
  const t = useTranslations("StudioHome.options")
  const tp = useTranslations("Studio.materials.presets")
  const cost = useCostLabel()

  if (step === "image") {
    const shown = shownImageChoice(options, flow.options?.image)
    return (
      <div className="studio-flow-settings">
        <label>
          <span>{t("image")}</span>
          <ImageChoiceSelect
            options={options}
            value={flow.options?.image}
            disabled={disabled}
            onChange={(c) => onChange(withOption(flow, "image", c))}
          />
        </label>
        {shown && (
          <p className="studio-flow-settings-note">
            {cost(shown)}
            {shown.billing !== "local"
              ? ` — ${t(`about.${shown.billing}`)}`
              : ""}
          </p>
        )}
        {options?.note_code && (
          <p className="studio-flow-settings-note">
            {t(`note.${options.note_code}`)}
          </p>
        )}
      </div>
    )
  }

  if (step === "model") {
    const m = modelChoice(flow)
    const presets = options?.model.presets ?? []
    const preset = presets.find((p) => p.id === m.use)
    const faces = m.target_faces ?? preset?.target_faces ?? 10000
    const texture = m.texture_size ?? preset?.texture_size ?? 2048
    const range = options?.model.target_faces ?? { min: 1000, max: 2000000 }
    const set = (patch: Partial<typeof m>) =>
      onChange(
        withOption(flow, "model", {
          ...m,
          target_faces: faces,
          texture_size: texture,
          ...patch,
        })
      )
    return (
      <div className="studio-flow-settings">
        <label>
          <span>{t("preset")}</span>
          <select
            value={m.use ?? ""}
            disabled={disabled}
            onChange={(e) => {
              const p = presets.find((x) => x.id === e.target.value)
              set(
                p
                  ? {
                      use: p.id,
                      target_faces: p.target_faces,
                      texture_size: p.texture_size,
                    }
                  : { use: undefined }
              )
            }}
          >
            <option value="">{t("custom")}</option>
            {m.use && !preset && (
              <option value={m.use}>{tp(m.use as "web-ar")}</option>
            )}
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {tp(p.id as "web-ar")} —{" "}
                {t("facesTexture", {
                  faces: p.target_faces,
                  texture: p.texture_size,
                })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("faces")}</span>
          <input
            type="number"
            min={range.min}
            max={range.max}
            step={500}
            value={faces}
            disabled={disabled}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              if (n >= range.min && n <= range.max) set({ target_faces: n })
            }}
          />
        </label>
        <label>
          <span>{t("texture")}</span>
          <select
            value={texture}
            disabled={disabled}
            onChange={(e) =>
              set({
                texture_size: Number(e.target.value) as 1024 | 2048 | 4096,
              })
            }
          >
            {(options?.model.texture_sizes ?? [1024, 2048, 4096]).map((s) => (
              <option key={s} value={s}>
                {s}²
              </option>
            ))}
          </select>
        </label>
        <label className="studio-flow-settings-check">
          <input
            type="checkbox"
            checked={Boolean(m.compress_textures)}
            disabled={disabled}
            onChange={(e) => set({ compress_textures: e.target.checked })}
          />
          <span>{t("compress")}</span>
        </label>
        <p className="studio-flow-settings-note">{t("billing.local")}</p>
      </div>
    )
  }

  if (step === "video") {
    const v = flow.options?.video ?? {}
    const list = options?.video ?? []
    const current =
      list.find((c) => c.workflow === v.workflow) ?? list.find((c) => c.default)
    const d = options?.duration ?? { min: 0.2, max: 15, default: 5 }
    const duration = v.duration ?? d.default
    return (
      <div className="studio-flow-settings">
        <label>
          <span>{t("video")}</span>
          <select
            value={current?.workflow ?? v.workflow ?? ""}
            disabled={disabled || list.length === 0}
            onChange={(e) =>
              onChange(
                withOption(flow, "video", { ...v, workflow: e.target.value })
              )
            }
          >
            {list.length === 0 && (
              <option value={v.workflow ?? ""}>
                {v.workflow ?? t("loading")}
              </option>
            )}
            {list.map((c) => (
              <option key={c.workflow} value={c.workflow}>
                {c.label}
                {c.audio ? ` · ${t("audio")}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("duration")}</span>
          <input
            type="number"
            min={Math.max(d.min, current?.min_duration ?? d.min)}
            max={d.max}
            step={0.5}
            value={duration}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (n >= d.min && n <= d.max)
                onChange(withOption(flow, "video", { ...v, duration: n }))
            }}
          />
        </label>
        <p className="studio-flow-settings-note">{t("billing.local")}</p>
      </div>
    )
  }

  return null
}

/** "어떤 모델 · 값으로 했나" — read off the material's provenance, so it
 *  shows what actually ran, not what the card is set to now. */
export function MadeWith({
  asset,
  options,
  seconds,
}: {
  asset: StudioAsset | undefined
  options: StudioGeneratorOptions | null
  /** How long this run took. */
  seconds?: number
}) {
  const t = useTranslations("StudioHome.options")
  const cost = useCostLabel()
  const src = asset?.source
  if (!src) return null
  const parts: string[] = []
  if (src.provider && src.provider !== "comfyui") {
    const c = options?.image.find(
      (x) =>
        x.provider === src.provider && (x.model ?? "") === (src.model ?? "")
    )
    parts.push(
      c ? c.label : [src.provider, src.model].filter(Boolean).join(" · ")
    )
    if (c) parts.push(cost(c))
  } else if (src.workflow) {
    parts.push(src.workflow)
    if (src.kind !== "render") parts.push(t("billing.local"))
  }
  const p = src.params
  if (src.kind === "3d") {
    if (p?.target_faces)
      parts.push(
        t("facesTexture", {
          faces: p.target_faces,
          texture: p.texture_size ?? "—",
        })
      )
    if (p?.compress_textures) parts.push(t("compressed"))
    if (typeof asset?.triangles === "number")
      parts.push(t("madeFaces", { faces: asset.triangles }))
  }
  if (src.kind === "video" && typeof p?.duration === "number")
    parts.push(t("secondsLong", { seconds: p.duration }))
  if (typeof seconds === "number" && parts.length > 0)
    parts.push(t("took", { seconds }))
  if (parts.length === 0) return null
  return (
    <p className="studio-flow-made" title={src.prompt}>
      {parts.join(" · ")}
    </p>
  )
}
