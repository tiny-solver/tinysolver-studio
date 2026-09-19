"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Circle,
  Download,
  ImagePlus,
  Layers,
  MousePointer2,
  Play,
  Redo2,
  Square,
  Undo2,
  Upload,
} from "lucide-react"
import {
  applyCommands,
  createDemoDocument,
  createNode,
  MAX_BUNDLE_BYTES,
  parseDocument,
  type StudioCommand,
  type StudioDocument,
  type StudioNode,
} from "@/lib/studio/document"
import {
  downloadText,
  exportBundle,
  importBundle,
  inspectImage,
  loadDraft,
  saveDraft,
} from "@/lib/studio/storage"
import "./studio.css"

const Viewport = dynamic(
  () => import("./studio-viewport").then((m) => m.StudioViewport),
  { ssr: false }
)
const EXAMPLE =
  '[\n  { "type": "node.update", "id": "signal",\n    "patch": { "color": "#ffcc66", "width": 150, "height": 150 } }\n]'

export function StudioWorkspace() {
  const t = useTranslations("Studio")
  const [document, setDocument] = useState<StudioDocument>(createDemoDocument)
  const current = useRef(document)
  const [blobs, setBlobs] = useState<Map<string, Blob>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>("switch")
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState("")
  const [error, setError] = useState("")
  const [storageFailed, setStorageFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [commands, setCommands] = useState(EXAMPLE)
  const [commandMessage, setCommandMessage] = useState("")
  const [history, setHistory] = useState<{
    past: StudioDocument[]
    future: StudioDocument[]
  }>({ past: [], future: [] })
  const version = useRef(0)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const failed = useRef(false)
  const imageInput = useRef<HTMLInputElement>(null)
  const bundleInput = useRef<HTMLInputElement>(null)
  const selected = document.nodes.find((node) => node.id === selectedId)
  const serialized = JSON.stringify(document)

  useEffect(() => {
    let cancelled = false
    loadDraft()
      .then((draft) => {
        if (cancelled) return
        if (draft) {
          current.current = draft.document
          setDocument(draft.document)
          setBlobs(draft.blobs)
          version.current = draft.version
          setSaved(JSON.stringify(draft.document))
          setSelectedId(null)
        }
        setReady(true)
      })
      .catch((reason) => {
        if (cancelled) return
        failed.current = true
        setStorageFailed(true)
        setError(String(reason))
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!ready || storageFailed || serialized === saved) return
    const timer = setTimeout(() => {
      const snapshot = document
      saveQueue.current = saveQueue.current.then(async () => {
        if (failed.current) return
        try {
          version.current = await saveDraft(snapshot, blobs, version.current)
          setSaved(JSON.stringify(snapshot))
        } catch (reason) {
          failed.current = true
          setStorageFailed(true)
          setError(String(reason))
        }
      })
    }, 450)
    return () => clearTimeout(timer)
  }, [document, blobs, ready, saved, serialized, storageFailed])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (ready && serialized !== saved) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [ready, serialized, saved])

  const commit = useCallback((next: StudioDocument) => {
    const previous = current.current
    const valid = parseDocument(next)
    if (JSON.stringify(previous) === JSON.stringify(valid)) return
    setHistory((h) => ({ past: [...h.past, previous].slice(-50), future: [] }))
    current.current = valid
    setDocument(valid)
    setError("")
  }, [])

  const dispatch = useCallback(
    (batch: unknown) => {
      try {
        commit(applyCommands(current.current, batch))
        return true
      } catch (reason) {
        setError(String(reason))
        return false
      }
    },
    [commit]
  )

  function updateNode(patch: Partial<StudioNode>) {
    if (selected) dispatch([{ type: "node.update", id: selected.id, patch }])
  }
  function addShape(kind: "rectangle" | "ellipse") {
    const node = createNode(kind, t(kind))
    if (dispatch([{ type: "node.add", node }])) setSelectedId(node.id)
  }
  function undo(redo = false) {
    const source = redo ? history.future : history.past
    const next = source[source.length - 1]
    if (!next) return
    setHistory(
      redo
        ? {
            past: [...history.past, current.current],
            future: source.slice(0, -1),
          }
        : {
            past: source.slice(0, -1),
            future: [...history.future, current.current],
          }
    )
    current.current = next
    setDocument(next)
  }
  async function addImage(file?: File) {
    if (!file) return
    setBusy(true)
    try {
      const asset = await inspectImage(file, file.name)
      const previous = current.current
      const next = {
        ...previous,
        assets: previous.assets.some((a) => a.id === asset.id)
          ? previous.assets
          : [...previous.assets, asset],
      }
      const scale = Math.min(1, 320 / asset.width, 240 / asset.height)
      const node: StudioNode = {
        ...createNode("rectangle", asset.name.slice(0, 120)),
        kind: "image",
        assetId: asset.id,
        color: "#ffffff",
        width: Math.max(1, Math.round(asset.width * scale)),
        height: Math.max(1, Math.round(asset.height * scale)),
      }
      const valid = applyCommands(next, [{ type: "node.add", node }])
      setBlobs((old) =>
        new Map(old).set(asset.id, new Blob([file], { type: asset.mime }))
      )
      commit(valid)
      setSelectedId(node.id)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  async function openBundle(file?: File) {
    if (!file) return
    setBusy(true)
    try {
      if (file.size > MAX_BUNDLE_BYTES) throw new Error(t("bundleTooLarge"))
      const imported = await importBundle(await file.text())
      // Keep bytes for undo history as well as the newly opened document.
      setBlobs((old) => new Map([...old, ...imported.blobs]))
      commit(imported.document)
      setSelectedId(null)
      setPlaying(false)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  async function download() {
    setBusy(true)
    try {
      downloadText(
        await exportBundle(current.current, blobs),
        `${current.current.id}.studio.json`
      )
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }
  const disabled = !ready || busy || playing
  const updateDocument = (
    patch: Extract<StudioCommand, { type: "document.update" }>["patch"]
  ) => dispatch([{ type: "document.update", patch }])

  return (
    <main className="studio-root">
      <header className="studio-header">
        <div className="studio-brand">
          <Link href="/workspace" aria-label={t("back")}>
            <ArrowLeft size={18} />
          </Link>
          <span className="studio-logo">
            <Layers size={19} />
          </span>
          <div>
            <strong>Content Studio</strong>
            <span>{t("prototype")}</span>
          </div>
        </div>
        <div className="studio-header-actions">
          <a href="/studio-plan.html">
            <BookOpen size={16} />
            {t("plan")}
          </a>
          <button
            onClick={() => bundleInput.current?.click()}
            disabled={!ready || busy}
          >
            <Upload size={16} />
            {t("open")}
          </button>
          <button onClick={download} disabled={!ready || busy}>
            <Download size={16} />
            {t("export")}
          </button>
          <button
            className="studio-primary"
            onClick={() => setPlaying(!playing)}
            disabled={!ready || busy}
          >
            {playing ? <MousePointer2 size={16} /> : <Play size={16} />}
            {playing ? t("edit") : t("preview")}
          </button>
        </div>
      </header>
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          void addImage(e.target.files?.[0])
          e.target.value = ""
        }}
      />
      <input
        ref={bundleInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          void openBundle(e.target.files?.[0])
          e.target.value = ""
        }}
      />
      <div className="studio-context">
        <span>
          <span className="studio-step">01</span>
          {t("common")}
          <span className="studio-divider">/</span>
          <span className="studio-step">02</span>
          {t("tool")}
          <span className="studio-divider">/</span>
          <span className="studio-step">03</span>Three.js
        </span>
        <span role="status">
          {!ready
            ? t("loading")
            : storageFailed
              ? t("saveFailed")
              : serialized === saved
                ? t("saved")
                : t("saving")}
        </span>
      </div>
      {error && (
        <div className="studio-error" role="alert">
          {error}
          <button onClick={() => setError("")}>{t("dismiss")}</button>
        </div>
      )}
      <div className="studio-body">
        <aside className="studio-sidebar">
          <div className="studio-section-title">
            <h2>{t("layers")}</h2>
            <span>{document.nodes.length}</span>
          </div>
          <div className="studio-add-tools">
            <button disabled={disabled} onClick={() => addShape("rectangle")}>
              <Square size={16} />
              {t("rectangle")}
            </button>
            <button disabled={disabled} onClick={() => addShape("ellipse")}>
              <Circle size={16} />
              {t("ellipse")}
            </button>
            <button
              disabled={disabled}
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlus size={16} />
              {t("image")}
            </button>
          </div>
          <div className="studio-layer-list">
            {[...document.nodes].reverse().map((node) => (
              <button
                key={node.id}
                className={selectedId === node.id ? "is-selected" : ""}
                aria-pressed={selectedId === node.id}
                disabled={playing}
                onClick={() => setSelectedId(node.id)}
              >
                <span
                  className="studio-layer-swatch"
                  style={{
                    background: node.color,
                    borderRadius: node.kind === "ellipse" ? "50%" : 3,
                  }}
                />
                <span>{node.name}</span>
                {!node.visible && <small>{t("hidden")}</small>}
              </button>
            ))}
          </div>
          <div className="studio-assets">
            <h2>{t("assets")}</h2>
            <p>{t("assetHint")}</p>
            {document.assets.length === 0 ? (
              <div className="studio-empty-assets">{t("noAssets")}</div>
            ) : (
              document.assets.map((asset) => (
                <div key={asset.id} className="studio-asset-row">
                  <ImagePlus size={16} />
                  <div>
                    <strong>{asset.name}</strong>
                    <span>
                      {asset.width} × {asset.height} ·{" "}
                      {Math.ceil(asset.size / 1024)} KB
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="studio-local-note">{t("localNote")}</div>
        </aside>
        <section className="studio-canvas-panel">
          <div className="studio-canvas-toolbar">
            <div>
              <strong>{document.name}</strong>
              <span>
                {document.width} × {document.height}
              </span>
            </div>
            <div>
              <button
                aria-label={t("undo")}
                title={t("undo")}
                disabled={disabled || !history.past.length}
                onClick={() => undo()}
              >
                <Undo2 size={17} />
              </button>
              <button
                aria-label={t("redo")}
                title={t("redo")}
                disabled={disabled || !history.future.length}
                onClick={() => undo(true)}
              >
                <Redo2 size={17} />
              </button>
              <span className="studio-mode">
                {playing ? t("preview") : t("edit")}
              </span>
            </div>
          </div>
          <div className="studio-canvas-area">
            {ready && (
              <Viewport
                key={playing ? "play" : "edit"}
                document={document}
                blobs={blobs}
                selectedId={selectedId}
                playing={playing}
                onSelect={setSelectedId}
                onMove={(id, x, y) =>
                  dispatch([{ type: "node.update", id, patch: { x, y } }])
                }
              />
            )}
          </div>
          <div className="studio-canvas-caption">
            <span>{playing ? t("playHint") : t("dragHint")}</span>
            <span>{t("instant")}</span>
          </div>
          <details className="studio-command-panel">
            <summary>{t("commands")}</summary>
            <p>{t("commandHint")}</p>
            <textarea
              aria-label={t("commands")}
              value={commands}
              onChange={(e) => setCommands(e.target.value)}
              spellCheck={false}
            />
            <div>
              <button
                disabled={disabled}
                onClick={() => {
                  try {
                    if (dispatch(JSON.parse(commands))) {
                      setCommandMessage(t("commandsApplied"))
                      setSelectedId(null)
                    }
                  } catch (reason) {
                    setError(String(reason))
                  }
                }}
              >
                {t("applyCommands")}
              </button>
              <span role="status">{commandMessage}</span>
            </div>
          </details>
        </section>
        <aside className="studio-inspector">
          <h2>{t("inspector")}</h2>
          <fieldset disabled={disabled}>
            <label>
              {t("sceneName")}
              <input
                value={document.name}
                onChange={(e) => updateDocument({ name: e.target.value })}
              />
            </label>
            <label className="studio-color-field">
              {t("background")}
              <input
                aria-label={t("background")}
                type="color"
                value={document.background}
                onChange={(e) => updateDocument({ background: e.target.value })}
              />
              <code>{document.background}</code>
            </label>
            <hr />
            {selected ? (
              <>
                <div className="studio-object-type">
                  {selected.kind}
                  <code>{selected.id}</code>
                </div>
                <label>
                  {t("name")}
                  <input
                    value={selected.name}
                    onChange={(e) => updateNode({ name: e.target.value })}
                  />
                </label>
                <div className="studio-fields-grid">
                  {(["x", "y", "width", "height"] as const).map((key) => (
                    <label key={key}>
                      {t(key)}
                      <input
                        aria-label={t(key)}
                        type="number"
                        min={key === "width" || key === "height" ? 1 : -8192}
                        max={8192}
                        value={selected[key]}
                        onChange={(e) => {
                          if (e.target.value !== "")
                            updateNode({ [key]: Number(e.target.value) })
                        }}
                      />
                    </label>
                  ))}
                </div>
                <label className="studio-color-field">
                  {t("color")}
                  <input
                    aria-label={t("color")}
                    type="color"
                    value={selected.color}
                    onChange={(e) => updateNode({ color: e.target.value })}
                  />
                  <code>{selected.color}</code>
                </label>
                <label className="studio-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.visible}
                    onChange={(e) => updateNode({ visible: e.target.checked })}
                  />
                  {t("visible")}
                </label>
                <div className="studio-layer-actions">
                  <button
                    onClick={() =>
                      dispatch([
                        {
                          type: "node.reorder",
                          id: selected.id,
                          direction: "forward",
                        },
                      ])
                    }
                  >
                    <ArrowUp size={15} />
                    {t("forward")}
                  </button>
                  <button
                    onClick={() =>
                      dispatch([
                        {
                          type: "node.reorder",
                          id: selected.id,
                          direction: "backward",
                        },
                      ])
                    }
                  >
                    <ArrowDown size={15} />
                    {t("backward")}
                  </button>
                </div>
                <hr />
                <h3>{t("interaction")}</h3>
                <label>
                  {t("toggleTarget")}
                  <select
                    value={selected.toggleTarget ?? ""}
                    onChange={(e) =>
                      updateNode({ toggleTarget: e.target.value })
                    }
                  >
                    <option value="">{t("none")}</option>
                    {document.nodes
                      .filter((node) => node.id !== selected.id)
                      .map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.name}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="studio-field-hint">{t("interactionHint")}</p>
                <button
                  className="studio-delete"
                  onClick={() => {
                    if (dispatch([{ type: "node.remove", id: selected.id }]))
                      setSelectedId(null)
                  }}
                >
                  {t("delete")}
                </button>
              </>
            ) : (
              <p className="studio-field-hint">{t("selectHint")}</p>
            )}
          </fieldset>
        </aside>
      </div>
    </main>
  )
}
