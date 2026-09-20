"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, RotateCcw, Trash2 } from "lucide-react"

import {
  effectiveConfig,
  readBehaviors,
  trimConfig,
  writeBehaviors,
  type Behavior,
  type EngineInfo,
} from "@/lib/studio/behaviors"
import {
  sceneActions,
  type ActionStep,
  type SceneCommand,
  type SceneFile,
  type SceneNode,
} from "@/lib/studio/document"

/**
 * Inspector sections for what the managed engine adds on top of placement:
 * behaviors (`props.script`), drawing props, `logic.actions`, and the live
 * game variables while playing. Everything goes through the same validated
 * commands as a drag, so an agent's `studio_apply_scene_commands` and these
 * controls are interchangeable.
 */

type Dispatch = (commands: SceneCommand[]) => boolean

/** One editable config value. Numbers and booleans get proper inputs;
 *  anything else (lists, objects, strings) is edited as JSON text. */
function ConfigField({
  name,
  value,
  onChange,
}: {
  name: string
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (typeof value === "boolean")
    return (
      <label className="studio-checkbox">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
        />
        {name}
      </label>
    )
  if (typeof value === "number")
    return (
      <label>
        {name}
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => {
            if (e.target.value !== "") onChange(Number(e.target.value))
          }}
        />
      </label>
    )
  return <JsonField name={name} value={value} onChange={onChange} />
}

function JsonField({
  name,
  value,
  onChange,
}: {
  name: string
  value: unknown
  onChange: (value: unknown) => void
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  // Keyed on the committed value so an outside change (undo, agent edit)
  // replaces a draft instead of fighting it.
  return (
    <label>
      {name}
      <input
        key={text}
        defaultValue={text}
        spellCheck={false}
        onBlur={(e) => {
          const raw = e.target.value
          if (raw === text) return
          if (typeof value === "string") return onChange(raw)
          try {
            onChange(JSON.parse(raw))
          } catch {
            e.target.value = text
          }
        }}
      />
    </label>
  )
}

export function BehaviorsSection({
  node,
  info,
  dispatch,
}: {
  node: SceneNode
  info: EngineInfo
  dispatch: Dispatch
}) {
  const t = useTranslations("Studio")
  const [adding, setAdding] = useState("")
  const behaviors = readBehaviors(node.props.script)
  const commit = (list: Behavior[]) =>
    dispatch([
      {
        type: "node.update",
        id: node.id,
        props: { script: writeBehaviors(list) },
      },
    ])
  const available = info.scripts.filter(
    (name) => !behaviors.some((b) => b.name === name)
  )

  return (
    <>
      <h3>{t("behaviors")}</h3>
      {behaviors.length === 0 && (
        <p className="studio-field-hint">{t("behaviorsHint")}</p>
      )}
      {behaviors.map((behavior, index) => {
        const config = effectiveConfig(behavior, info)
        const known = info.scripts.includes(behavior.name)
        return (
          <div key={`${behavior.name}:${index}`} className="studio-behavior">
            <div className="studio-behavior-head">
              <code>{behavior.name}</code>
              {info.scripts.length > 0 && !known && (
                <span className="studio-behavior-unknown">
                  {t("behaviorUnknown")}
                </span>
              )}
              <button
                aria-label={t("behaviorRemove", { name: behavior.name })}
                title={t("behaviorRemove", { name: behavior.name })}
                onClick={() => commit(behaviors.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="studio-fields-grid">
              {Object.entries(config).map(([key, value]) => (
                <ConfigField
                  key={key}
                  name={key}
                  value={value}
                  onChange={(next) =>
                    commit(
                      behaviors.map((b, i) =>
                        i === index
                          ? {
                              name: b.name,
                              config: trimConfig(
                                b.name,
                                { ...config, [key]: next },
                                info
                              ),
                            }
                          : b
                      )
                    )
                  }
                />
              ))}
            </div>
          </div>
        )
      })}
      <div className="studio-behavior-add">
        <input
          aria-label={t("behaviorAdd")}
          list="studio-script-names"
          placeholder={t("behaviorAdd")}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        />
        <datalist id="studio-script-names">
          {available.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          disabled={!/^[a-zA-Z0-9_-]{1,100}$/.test(adding.trim())}
          onClick={() => {
            const name = adding.trim()
            if (commit([...behaviors, { name, config: {} }])) setAdding("")
          }}
        >
          <Plus size={14} />
        </button>
      </div>
    </>
  )
}

const DRAW_FIELDS = [
  { key: "opacity", fallback: 1, min: 0, max: 1, step: 0.05 },
  { key: "rotation", fallback: 0, min: -360, max: 360, step: 1 },
  { key: "scale", fallback: 1, min: 0.01, max: 100, step: 0.05 },
] as const

export function DrawSection({
  node,
  onProps,
}: {
  node: SceneNode
  onProps: (patch: Record<string, unknown>) => void
}) {
  const t = useTranslations("Studio")
  return (
    <>
      <div className="studio-fields-grid">
        {DRAW_FIELDS.map((field) => {
          const raw = node.props[field.key]
          const value = typeof raw === "number" ? raw : field.fallback
          return (
            <label key={field.key}>
              {t(field.key)}
              <input
                aria-label={t(field.key)}
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                value={value}
                onChange={(e) => {
                  if (e.target.value === "") return
                  const next = Math.min(
                    field.max,
                    Math.max(field.min, Number(e.target.value))
                  )
                  onProps({ [field.key]: next })
                }}
              />
            </label>
          )
        })}
      </div>
      <label className="studio-checkbox">
        <input
          type="checkbox"
          checked={node.props.flipX === true}
          onChange={(e) => onProps({ flipX: e.target.checked })}
        />
        {t("flipX")}
      </label>
    </>
  )
}

export function ActionsSection({
  scene,
  info,
  dispatch,
  onError,
}: {
  scene: SceneFile
  info: EngineInfo
  dispatch: Dispatch
  onError: (message: string) => void
}) {
  const t = useTranslations("Studio")
  const actions = sceneActions(scene)
  const names = Object.keys(actions).sort()
  const [picked, setPicked] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const current = picked !== null && picked in actions ? picked : null
  const used = new Set(
    scene.document.nodes
      .map((n) => n.props.onClick)
      .filter((v): v is string => typeof v === "string")
  )

  return (
    <details className="studio-actions">
      <summary>
        {t("actions")} <span>{names.length}</span>
      </summary>
      <p className="studio-field-hint">
        {t("actionsHint")}
        {info.ops.length > 0 && (
          <>
            {" "}
            <code>{info.ops.join(" · ")}</code>
          </>
        )}
      </p>
      <div className="studio-action-list">
        {names.map((name) => (
          <button
            key={name}
            className={name === current ? "is-active" : undefined}
            onClick={() => setPicked(name === current ? null : name)}
          >
            {name}
            {!used.has(name) && <span>{t("actionUnused")}</span>}
          </button>
        ))}
      </div>
      {current && (
        <ActionEditor
          key={`${current}:${JSON.stringify(actions[current])}`}
          name={current}
          steps={actions[current]}
          onApply={(steps) =>
            dispatch([{ type: "action.set", name: current, steps }])
          }
          onRemove={() => {
            if (dispatch([{ type: "action.remove", name: current }]))
              setPicked(null)
          }}
          onError={onError}
        />
      )}
      <div className="studio-behavior-add">
        <input
          aria-label={t("actionNew")}
          placeholder={t("actionNew")}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          disabled={
            !/^[a-zA-Z0-9_-]{1,100}$/.test(newName.trim()) ||
            newName.trim() in actions
          }
          onClick={() => {
            const name = newName.trim()
            if (
              dispatch([
                {
                  type: "action.set",
                  name,
                  steps: [{ op: "say", text: name }],
                },
              ])
            ) {
              setPicked(name)
              setNewName("")
            }
          }}
        >
          <Plus size={14} />
        </button>
      </div>
    </details>
  )
}

function ActionEditor({
  name,
  steps,
  onApply,
  onRemove,
  onError,
}: {
  name: string
  steps: ActionStep[]
  onApply: (steps: ActionStep[]) => boolean
  onRemove: () => void
  onError: (message: string) => void
}) {
  const t = useTranslations("Studio")
  const [text, setText] = useState(() => JSON.stringify(steps, null, 2))
  return (
    <div className="studio-action-editor">
      <textarea
        aria-label={t("actionSteps", { name })}
        rows={Math.min(14, Math.max(4, text.split("\n").length))}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="studio-layer-actions">
        <button
          onClick={() => {
            try {
              onApply(JSON.parse(text))
            } catch (reason) {
              onError(reason instanceof Error ? reason.message : String(reason))
            }
          }}
        >
          {t("actionApply")}
        </button>
        <button onClick={onRemove}>
          <Trash2 size={14} />
          {t("actionRemove")}
        </button>
      </div>
    </div>
  )
}

/** Live `engine.state` while the game plays, with a way back to the start. */
export function StatePanel({
  state,
  onReset,
}: {
  state: Record<string, unknown>
  onReset: () => void
}) {
  const t = useTranslations("Studio")
  const entries = Object.entries(state)
  return (
    <div className="studio-state" role="status" aria-label={t("gameState")}>
      <strong>{t("gameState")}</strong>
      {entries.length === 0 ? (
        <span className="studio-state-empty">{t("gameStateEmpty")}</span>
      ) : (
        entries.map(([key, value]) => (
          <span key={key}>
            <code>{key}</code>
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        ))
      )}
      <button onClick={onReset} title={t("gameResetHint")}>
        <RotateCcw size={14} />
        {t("gameReset")}
      </button>
    </div>
  )
}
