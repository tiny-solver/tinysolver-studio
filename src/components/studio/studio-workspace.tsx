"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Compass,
  ExternalLink,
  FilePlus2,
  Hammer,
  ImageIcon,
  Layers,
  MessageSquarePlus,
  MousePointer2,
  Play,
  Redo2,
  RefreshCw,
  Rocket,
  Square,
  Type,
  Undo2,
} from "lucide-react"
import {
  ANCHORS,
  applyCommands,
  createNode,
  isVisible,
  parseScene,
  type SceneAnchor,
  type SceneFile,
  type SceneNode,
} from "@/lib/studio/document"
import {
  affectsPreview,
  createScene,
  listScenes,
  loadScene,
  peekSceneEtag,
  resolveProjectTarget,
  saveScene,
  scenePath,
  type StudioProjectTarget,
} from "@/lib/studio/project-storage"
import {
  buildContentProject,
  getContentPreview,
  listContentBuilds,
  publishContentBuild,
  unpublishContentGame,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { buildAgentContext } from "@/lib/studio/agent-context"
import { revealItemInDir, isLocalDesktop } from "@/lib/platform"
import { BrowserLink } from "@/components/ui/browser-link"
import { getServerBaseUrl } from "@/lib/transport"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import type { ContentBuild, ContentScene } from "@/lib/types"
import { StudioStage } from "./studio-stage"
import { useChatBridge, useEngineErrorList } from "./use-chat-bridge"
import "./studio.css"

const EXAMPLE =
  '[\n  { "type": "node.update", "id": "title",\n    "transform": { "y": 260 }, "props": { "color": "#ffcc66" } }\n]'

interface StudioWorkspaceProps {
  /** Workspace folder whose `outputs/game/content/*.studio.json` is edited
   *  and whose game is previewed. The /studio page reads it from `?path=`;
   *  the workspace's file pane passes it in. */
  projectRoot?: string | null
  /** Rendered inside the workspace's file pane: fill the container and drop
   *  the page-level back link. */
  embedded?: boolean
}

interface Preview {
  /** `<origin>/api/content-preview/<id>/` */
  base: string
  /** Origin that serves previews and published games (`/play/<slug>/`). */
  origin: string
  sameOrigin: boolean
}

export function StudioWorkspace({
  projectRoot = null,
  embedded = false,
}: StudioWorkspaceProps = {}) {
  const t = useTranslations("Studio")
  const [target, setTarget] = useState<StudioProjectTarget | null>(null)
  const [scenes, setScenes] = useState<ContentScene[]>([])
  const [sceneId, setSceneId] = useState<string | null>(null)
  const [scene, setScene] = useState<SceneFile | null>(null)
  const current = useRef<SceneFile | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [saved, setSaved] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [storageFailed, setStorageFailed] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [hot, setHot] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const chat = useChatBridge()
  const [builds, setBuilds] = useState<ContentBuild[]>([])
  const [building, setBuilding] = useState(false)
  const [publishing, setPublishing] = useState<string | null>(null)
  const [commands, setCommands] = useState(EXAMPLE)
  const [commandMessage, setCommandMessage] = useState("")
  const [rawProps, setRawProps] = useState("")
  const [history, setHistory] = useState<{
    past: SceneFile[]
    future: SceneFile[]
  }>({
    past: [],
    future: [],
  })
  const etag = useRef<string | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const failed = useRef(false)
  const hotRef = useRef(false)
  hotRef.current = hot

  const selected =
    scene?.document.nodes.find((n) => n.id === selectedId) ?? null
  const serialized = scene ? JSON.stringify(scene) : ""

  // ── Loading ──────────────────────────────────────────────────────

  const loadOne = useCallback(
    async (
      resolved: StudioProjectTarget,
      id: string,
      cancelled: () => boolean
    ) => {
      const loaded = await loadScene(resolved, id)
      if (cancelled()) return
      if (!loaded) {
        current.current = null
        setScene(null)
        etag.current = null
        setSaved("")
      } else {
        current.current = loaded.scene
        setScene(loaded.scene)
        etag.current = loaded.etag
        // A migrated file is saved back in the new schema on the first edit;
        // until then it is "unsaved" so the note is honest.
        setSaved(loaded.migrated ? "" : JSON.stringify(loaded.scene))
        setNotice(loaded.migrated ? t("migrated") : "")
      }
      setSceneId(id)
      setSelectedId(null)
      setHistory({ past: [], future: [] })
      failed.current = false
      setStorageFailed(false)
      setDiskChanged(false)
      setError("")
    },
    [t]
  )

  const loadFromStore = useCallback(
    async (cancelled: () => boolean, preferred?: string | null) => {
      if (!projectRoot) return
      try {
        const resolved = await resolveProjectTarget(projectRoot)
        const list = await listScenes(resolved)
        if (cancelled()) return
        setTarget(resolved)
        setScenes(list)
        const pick =
          (preferred && list.some((s) => s.id === preferred) && preferred) ||
          (list.some((s) => s.id === "main") ? "main" : list[0]?.id) ||
          null
        if (pick) await loadOne(resolved, pick, cancelled)
        else {
          current.current = null
          setScene(null)
          setSceneId(null)
          etag.current = null
        }
        if (cancelled()) return
        setReady(true)
      } catch (reason) {
        if (cancelled()) return
        failed.current = true
        setStorageFailed(true)
        setError(toErrorMessage(reason))
        setReady(true)
      }
    },
    [projectRoot, loadOne]
  )

  useEffect(() => {
    let cancelled = false
    void loadFromStore(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [loadFromStore])

  // Preview server for the iframe. Desktop gets a loopback origin; web and
  // remote-desktop windows go through the API origin they already use.
  useEffect(() => {
    if (!projectRoot) return
    let cancelled = false
    getContentPreview(projectRoot)
      .then((info) => {
        if (cancelled) return
        const origin = info.loopback ?? getServerBaseUrl()
        setPreview({
          origin,
          base: `${origin}${info.path.replace(/\/+$/, "")}/`,
          sameOrigin: Boolean(info.loopback) && isLocalDesktop(),
        })
      })
      .catch((reason) => {
        if (!cancelled) setError(toErrorMessage(reason))
      })
    return () => {
      cancelled = true
    }
  }, [projectRoot])

  useEffect(() => {
    if (!target?.manifest?.engine) return
    listContentBuilds(target.root)
      .then(setBuilds)
      .catch((reason) => console.warn("[studio] builds:", reason))
  }, [target])

  // ── File watching ─────────────────────────────────────────────────
  // The same per-root stream the file tabs use. Our own saves echo back as
  // events on the scene path; they are recognized by etag and ignored.
  useEffect(() => {
    if (!target || !ready) return
    const store = getWorkspaceStateStore(target.root)
    const token = store.acquire("paths")
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const unsubscribe = store.subscribeEnvelopes((envelope) => {
      const id = sceneId
      const ownPath = id ? scenePath(target, id) : null
      let previewChanged = false
      let scenesChanged = false
      for (const rel of envelope.changed_paths) {
        const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "")
        if (ownPath && norm === ownPath) {
          peekSceneEtag(target, id!)
            .then((onDisk) => {
              if (disposed || onDisk === etag.current) return
              if (
                JSON.stringify(current.current) === saved ||
                !current.current
              ) {
                void loadOne(target, id!, () => disposed).then(() => {
                  if (!hotRef.current) setReloadToken((n) => n + 1)
                })
              } else setDiskChanged(true)
            })
            .catch((reason) =>
              console.warn("[studio] etag check failed:", reason)
            )
          continue
        }
        if (
          norm.startsWith(`${target.contentDir}/`) &&
          norm.endsWith(".studio.json")
        )
          scenesChanged = true
        if (affectsPreview(target, norm)) previewChanged = true
      }
      if (scenesChanged)
        listScenes(target)
          .then((list) => {
            if (!disposed) setScenes(list)
          })
          .catch(() => {})
      if (previewChanged) {
        if (reloadTimer) clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => setReloadToken((n) => n + 1), 300)
      }
    })
    return () => {
      disposed = true
      if (reloadTimer) clearTimeout(reloadTimer)
      unsubscribe()
      store.release(token)
    }
  }, [target, ready, sceneId, saved, loadOne])

  // ── Autosave ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || storageFailed || !scene || !target || serialized === saved)
      return
    const timer = setTimeout(() => {
      const snapshot = scene
      saveQueue.current = saveQueue.current.then(async () => {
        if (failed.current) return
        try {
          etag.current = await saveScene(target, snapshot, etag.current)
          setSaved(JSON.stringify(snapshot))
          setNotice("")
          // An engine without hot reload sees the edit only after a reload.
          if (!hotRef.current) setReloadToken((n) => n + 1)
        } catch (reason) {
          failed.current = true
          setStorageFailed(true)
          setError(toErrorMessage(reason))
        }
      })
    }, 450)
    return () => clearTimeout(timer)
  }, [scene, ready, saved, serialized, storageFailed, target])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (ready && scene && serialized !== saved) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [ready, scene, serialized, saved])

  useEffect(() => {
    setRawProps(selected ? JSON.stringify(selected.props, null, 2) : "")
  }, [selected])

  // ── Editing ───────────────────────────────────────────────────────
  const commit = useCallback((next: SceneFile) => {
    const previous = current.current
    const valid = parseScene(next)
    if (previous && JSON.stringify(previous) === JSON.stringify(valid)) return
    if (previous)
      setHistory((h) => ({
        past: [...h.past, previous].slice(-50),
        future: [],
      }))
    current.current = valid
    setScene(valid)
    setError("")
  }, [])

  const dispatch = useCallback(
    (batch: unknown) => {
      if (!current.current) return false
      try {
        commit(applyCommands(current.current, batch))
        return true
      } catch (reason) {
        setError(toErrorMessage(reason))
        return false
      }
    },
    [commit]
  )

  const updateTransform = (patch: Partial<SceneNode["transform"]>) => {
    if (selected)
      dispatch([{ type: "node.update", id: selected.id, transform: patch }])
  }
  const updateProps = (patch: Record<string, unknown>) => {
    if (selected)
      dispatch([{ type: "node.update", id: selected.id, props: patch }])
  }
  function addNode(type: "rect" | "text" | "sprite") {
    if (!current.current) return
    const taken = new Set(current.current.document.nodes.map((n) => n.id))
    let n = 1
    while (taken.has(`${type}_${n}`)) n += 1
    const node = createNode(type, `${type}_${n}`)
    if (dispatch([{ type: "node.add", node }])) setSelectedId(node.id)
  }
  function undo(redo = false) {
    const source = redo ? history.future : history.past
    const next = source[source.length - 1]
    if (!next || !current.current) return
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
    setScene(next)
  }
  async function newScene() {
    if (!target) return
    const id = window.prompt(t("newSceneId"), "")?.trim()
    if (!id) return
    setBusy(true)
    try {
      await createScene(target, id)
      await loadFromStore(() => false, id)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  async function switchScene(id: string) {
    if (!target || id === sceneId) return
    setBusy(true)
    try {
      await loadOne(target, id, () => false)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  async function build() {
    if (!target) return
    setBuilding(true)
    setError("")
    try {
      const result = await buildContentProject(target.root)
      setBuilds((list) => [
        result,
        ...list.filter((b) => b.version !== result.version),
      ])
      setNotice(t("buildDone", { version: result.version }))
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBuilding(false)
    }
  }

  // Release: `local` is this Studio's own /play/<slug>/ link, `command` the
  // project's deploy command. Either way the builds list is re-read, because
  // re-pointing the local link edits another build's record too.
  async function publish(version: string, where: "local" | "command") {
    if (!target) return
    setPublishing(`${version}:${where}`)
    setError("")
    try {
      const result = await publishContentBuild(target.root, where, version)
      setBuilds(await listContentBuilds(target.root))
      const record = result.published?.find((r) => r.target === where)
      setNotice(
        record?.url
          ? t("publishDone", { url: publicUrl(record.url) })
          : t("publishNoUrl")
      )
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setPublishing(null)
    }
  }

  async function unpublish() {
    if (!target) return
    setError("")
    try {
      await unpublishContentGame(target.root)
      setBuilds(await listContentBuilds(target.root))
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }

  /** A `local` record holds a path on the Studio's origin. */
  const publicUrl = (url: string) =>
    url.startsWith("/") ? `${preview?.origin ?? ""}${url}` : url

  const onReady = useCallback((isHot: boolean) => setHot(isHot), [])
  // Scoped to the running engine: a reload or another scene starts over.
  const {
    errors: engineErrors,
    push: onEngineError,
    clear: clearEngineErrors,
  } = useEngineErrorList(`${reloadToken}:${sceneId ?? ""}`)
  const onMove = useCallback(
    (id: string, x: number, y: number) =>
      dispatch([{ type: "node.update", id, transform: { x, y } }]),
    [dispatch]
  )

  const disabled = !ready || busy || playing || !scene
  const src =
    preview && target && sceneId
      ? `${preview.base}${target.entry}?scene=${encodeURIComponent(sceneId)}`
      : null
  const hasEngine = Boolean(target?.manifest?.engine)

  // Hand the agent what the user is looking at: the scene file as a badge,
  // plus the selection and the preview's runtime errors as text. The user
  // types the actual request after it.
  const sendToChat = () => {
    if (!target || !scene) return
    const rel = scenePath(target, scene.id)
    const sent = chat.send(
      buildAgentContext({
        projectName: target.manifest?.name ?? null,
        scenePath: rel,
        scene,
        selected,
        hot,
        engineErrors,
      }),
      joinFsPath(target.root, rel)
    )
    if (sent) setNotice(t("contextSent"))
  }

  if (!projectRoot) {
    return (
      <main
        className={embedded ? "studio-root studio-embedded" : "studio-root"}
      >
        <div className="studio-blank">
          <Layers size={28} />
          <p>{t("noProjectOpen")}</p>
          {!embedded && <Link href="/workspace">{t("back")}</Link>}
        </div>
      </main>
    )
  }

  return (
    <main className={embedded ? "studio-root studio-embedded" : "studio-root"}>
      <header className="studio-header">
        <div className="studio-brand">
          {!embedded && (
            <Link href="/workspace" aria-label={t("back")}>
              <ArrowLeft size={18} />
            </Link>
          )}
          <span className="studio-logo">
            <Layers size={19} />
          </span>
          <div>
            <strong>Content Studio</strong>
            <span>{target?.manifest?.name ?? projectRoot}</span>
          </div>
        </div>
        <div className="studio-header-actions">
          <a href="/studio-plan.html">
            <BookOpen size={16} />
            {t("plan")}
          </a>
          <a href="/how-built.html">
            <Compass size={16} />
            {t("howBuilt")}
          </a>
          <label className="studio-scene-pick">
            {t("scene")}
            <select
              aria-label={t("scene")}
              value={sceneId ?? ""}
              disabled={!ready || busy || scenes.length === 0}
              onChange={(e) => void switchScene(e.target.value)}
            >
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name === s.id ? s.id : `${s.name} · ${s.id}`}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void newScene()}
            disabled={!ready || busy || !target}
          >
            <FilePlus2 size={16} />
            {t("newScene")}
          </button>
          <button
            onClick={() => void loadFromStore(() => false, sceneId)}
            disabled={!ready || busy}
            title={t("reload")}
          >
            <RefreshCw size={16} />
            {t("reload")}
          </button>
          {src && (
            <BrowserLink href={src}>
              <ExternalLink size={16} />
              {t("previewOpen")}
            </BrowserLink>
          )}
          <button
            onClick={sendToChat}
            disabled={!ready || !scene || !chat.canSend}
            title={
              chat.canSend ? t("sendToChatHint") : t("sendToChatNoSession")
            }
          >
            <MessageSquarePlus size={16} />
            {t("sendToChat")}
          </button>
          <button
            onClick={() => void build()}
            disabled={!ready || busy || building || !hasEngine}
            title={hasEngine ? t("buildHint") : t("engineMissing")}
          >
            <Hammer size={16} />
            {building ? t("building") : t("build")}
          </button>
          <button
            className="studio-primary"
            onClick={() => setPlaying(!playing)}
            disabled={!ready || busy || !scene}
          >
            {playing ? <MousePointer2 size={16} /> : <Play size={16} />}
            {playing ? t("edit") : t("preview")}
          </button>
        </div>
      </header>
      <div className="studio-context">
        <span>
          {target && (
            <>
              {t("projectMode", { path: target.manifest?.name ?? target.root })}
              <span className="studio-divider">/</span>
              {sceneId ? scenePath(target, sceneId) : t("noScenes")}
              <span className="studio-divider">/</span>
              {src
                ? hot
                  ? t("hotLive")
                  : t("hotReload")
                : t("previewStarting")}
            </>
          )}
        </span>
        <span role="status">
          {!ready
            ? t("loadingProject")
            : storageFailed
              ? t("conflict")
              : !scene
                ? ""
                : serialized === saved
                  ? t("savedProject", { path: scenePath(target!, scene.id) })
                  : t("saving")}
        </span>
      </div>
      {diskChanged && (
        <div className="studio-error" role="alert">
          {t("diskChanged")}
          <button onClick={() => void loadFromStore(() => false, sceneId)}>
            {t("reload")}
          </button>
          <button onClick={() => setDiskChanged(false)}>{t("dismiss")}</button>
        </div>
      )}
      {error && (
        <div className="studio-error" role="alert">
          {error}
          <button onClick={() => setError("")}>{t("dismiss")}</button>
        </div>
      )}
      {engineErrors.length > 0 && (
        <div className="studio-error" role="status">
          <span className="studio-engine-error">
            {t("engineErrors", { count: engineErrors.length })}
            {" · "}
            {engineErrors[engineErrors.length - 1].split("\n")[0]}
          </span>
          <button onClick={sendToChat} disabled={!chat.canSend}>
            {t("sendToChat")}
          </button>
          <button onClick={clearEngineErrors}>{t("dismiss")}</button>
        </div>
      )}
      {notice && (
        <div className="studio-notice" role="status">
          {notice}
          <button onClick={() => setNotice("")}>{t("dismiss")}</button>
        </div>
      )}
      <div className="studio-body">
        <aside className="studio-sidebar">
          <div className="studio-section-title">
            <h2>{t("layers")}</h2>
            <span>{scene?.document.nodes.length ?? 0}</span>
          </div>
          <div className="studio-add-tools">
            <button disabled={disabled} onClick={() => addNode("rect")}>
              <Square size={16} />
              {t("addRect")}
            </button>
            <button disabled={disabled} onClick={() => addNode("text")}>
              <Type size={16} />
              {t("addText")}
            </button>
            <button disabled={disabled} onClick={() => addNode("sprite")}>
              <ImageIcon size={16} />
              {t("addSprite")}
            </button>
          </div>
          <div className="studio-layer-list">
            {scene &&
              [...scene.document.nodes]
                .sort((a, b) => b.transform.z - a.transform.z)
                .map((node) => (
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
                        background:
                          typeof node.props.color === "string"
                            ? node.props.color
                            : typeof node.props.placeholder === "string"
                              ? node.props.placeholder
                              : "var(--muted-foreground)",
                        borderRadius: node.type === "text" ? 0 : 3,
                      }}
                    />
                    <span>{node.id}</span>
                    <small>{!isVisible(node) ? t("hidden") : node.type}</small>
                  </button>
                ))}
            {ready && !scene && (
              <div className="studio-empty-assets">
                {t("noScenes")}
                <button onClick={() => void newScene()} disabled={!target}>
                  {t("createScene")}
                </button>
              </div>
            )}
          </div>
          <div className="studio-assets">
            <h2>{t("assets")}</h2>
            <p>{t("assetHint")}</p>
            {!scene || scene.document.assets.length === 0 ? (
              <div className="studio-empty-assets">{t("noAssets")}</div>
            ) : (
              scene.document.assets.map((asset) => (
                <div key={asset.id} className="studio-asset-row">
                  <ImageIcon size={16} />
                  <div>
                    <strong>{asset.id}</strong>
                    <span>
                      {asset.file} · {asset.width}×{asset.height}
                      {asset.missing ? ` · ${t("missingAsset")}` : ""}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          {hasEngine && (
            <div className="studio-builds">
              <h2>{t("builds")}</h2>
              {builds.length === 0 ? (
                <p>{t("noBuilds")}</p>
              ) : (
                builds.slice(0, 5).map((b) => (
                  <div key={b.version} className="studio-build-row">
                    <strong>{b.version}</strong>
                    <span>
                      {new Date(b.built_at).toLocaleString()} ·{" "}
                      {Math.ceil(b.size_bytes / 1024)} KB
                    </span>
                    <div>
                      {isLocalDesktop() && (
                        <button
                          onClick={() => void revealItemInDir(b.zip ?? b.dir)}
                        >
                          {t("openBuildFolder")}
                        </button>
                      )}
                      <code title={b.dir}>
                        {b.zip ? t("buildZip") : b.entry}
                      </code>
                    </div>
                    <div className="studio-build-publish">
                      <button
                        onClick={() => void publish(b.version, "local")}
                        disabled={publishing !== null}
                        title={t("publishLocalHint")}
                      >
                        <Rocket size={14} />
                        {publishing === `${b.version}:local`
                          ? t("publishing")
                          : t("publishLocal")}
                      </button>
                      {target?.manifest?.publish?.command && (
                        <button
                          onClick={() => void publish(b.version, "command")}
                          disabled={publishing !== null}
                          title={target.manifest.publish.command}
                        >
                          {publishing === `${b.version}:command`
                            ? t("publishing")
                            : t("publishCommand")}
                        </button>
                      )}
                    </div>
                    {(b.published ?? []).map((record) => (
                      <div
                        key={record.target}
                        className="studio-build-published"
                      >
                        {record.url ? (
                          <BrowserLink href={publicUrl(record.url)}>
                            <ExternalLink size={13} />
                            {publicUrl(record.url)}
                          </BrowserLink>
                        ) : (
                          <span>{t("publishNoUrl")}</span>
                        )}
                        {record.target === "local" && (
                          <button onClick={() => void unpublish()}>
                            {t("unpublish")}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
          <div className="studio-local-note">
            {target
              ? target.manifest
                ? t("projectNote")
                : t("notProject")
              : ""}
          </div>
        </aside>
        <section className="studio-canvas-panel">
          <div className="studio-canvas-toolbar">
            <div>
              <strong>{scene?.name ?? ""}</strong>
              {scene && (
                <span>
                  {scene.document.container.width} ×{" "}
                  {scene.document.container.height}
                </span>
              )}
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
            {ready && scene && (
              <StudioStage
                src={src}
                scene={scene}
                selectedId={selectedId}
                playing={playing}
                reloadToken={reloadToken}
                onSelect={setSelectedId}
                onMove={onMove}
                onReady={onReady}
                onEngineError={onEngineError}
                sameOrigin={preview?.sameOrigin ?? false}
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
                    setError(toErrorMessage(reason))
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
            {scene && (
              <label>
                {t("sceneName")}
                <input
                  value={scene.name}
                  onChange={(e) =>
                    dispatch([{ type: "scene.update", name: e.target.value }])
                  }
                />
              </label>
            )}
            <hr />
            {selected ? (
              <>
                <div className="studio-object-type">
                  {selected.type}
                  <code>{selected.id}</code>
                </div>
                <div className="studio-fields-grid">
                  {(
                    [
                      ["x", "x"],
                      ["y", "y"],
                      ["w", "width"],
                      ["h", "height"],
                      ["z", "z"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {t(label)}
                      <input
                        aria-label={t(label)}
                        type="number"
                        min={key === "w" || key === "h" ? 1 : undefined}
                        value={selected.transform[key]}
                        onChange={(e) => {
                          if (e.target.value !== "")
                            updateTransform({ [key]: Number(e.target.value) })
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    {t("anchor")}
                    <select
                      aria-label={t("anchor")}
                      value={selected.transform.anchor}
                      onChange={(e) =>
                        updateTransform({
                          anchor: e.target.value as SceneAnchor,
                        })
                      }
                    >
                      {ANCHORS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="studio-checkbox">
                  <input
                    type="checkbox"
                    checked={isVisible(selected)}
                    onChange={(e) => updateProps({ visible: e.target.checked })}
                  />
                  {t("visible")}
                </label>
                {selected.type === "sprite" && (
                  <label>
                    {t("asset")}
                    <select
                      aria-label={t("asset")}
                      value={
                        typeof selected.props.asset === "string"
                          ? selected.props.asset
                          : ""
                      }
                      onChange={(e) =>
                        updateProps({ asset: e.target.value || null })
                      }
                    >
                      <option value="">{t("noAsset")}</option>
                      {scene!.document.assets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.id}
                          {a.missing ? ` (${t("missingAsset")})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selected.type === "text" && (
                  <>
                    <label>
                      {t("text")}
                      <textarea
                        aria-label={t("text")}
                        rows={3}
                        value={
                          typeof selected.props.text === "string"
                            ? selected.props.text
                            : ""
                        }
                        onChange={(e) => updateProps({ text: e.target.value })}
                      />
                    </label>
                    <label>
                      {t("fontSize")}
                      <input
                        type="number"
                        min={1}
                        value={
                          typeof selected.props.size === "number"
                            ? selected.props.size
                            : 44
                        }
                        onChange={(e) => {
                          if (e.target.value !== "")
                            updateProps({ size: Number(e.target.value) })
                        }}
                      />
                    </label>
                  </>
                )}
                {(selected.type === "text" || selected.type === "rect") && (
                  <label className="studio-color-field">
                    {t("color")}
                    <input
                      aria-label={t("color")}
                      type="color"
                      value={
                        typeof selected.props.color === "string" &&
                        /^#[0-9a-fA-F]{6}$/.test(selected.props.color)
                          ? selected.props.color
                          : "#ffffff"
                      }
                      onChange={(e) => updateProps({ color: e.target.value })}
                    />
                    <code>
                      {typeof selected.props.color === "string"
                        ? selected.props.color
                        : ""}
                    </code>
                  </label>
                )}
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
                <label className="studio-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.props.interactive === true}
                    onChange={(e) =>
                      updateProps({ interactive: e.target.checked })
                    }
                  />
                  {t("interactive")}
                </label>
                <label>
                  {t("onClick")}
                  <input
                    value={
                      typeof selected.props.onClick === "string"
                        ? selected.props.onClick
                        : ""
                    }
                    onChange={(e) =>
                      updateProps({ onClick: e.target.value || null })
                    }
                  />
                </label>
                <p className="studio-field-hint">{t("onClickHint")}</p>
                <details>
                  <summary>{t("rawProps")}</summary>
                  <p className="studio-field-hint">{t("rawPropsHint")}</p>
                  <textarea
                    aria-label={t("rawProps")}
                    rows={8}
                    value={rawProps}
                    spellCheck={false}
                    onChange={(e) => setRawProps(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(rawProps)
                        if (
                          !parsed ||
                          typeof parsed !== "object" ||
                          Array.isArray(parsed)
                        )
                          throw new Error("props: expected an object")
                        if (current.current) {
                          const next = structuredClone(current.current)
                          const node = next.document.nodes.find(
                            (n) => n.id === selected.id
                          )
                          if (node) {
                            node.props = parsed
                            commit(next)
                          }
                        }
                      } catch (reason) {
                        setError(toErrorMessage(reason))
                      }
                    }}
                  >
                    {t("applyProps")}
                  </button>
                </details>
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
