"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import {
  isVisible,
  nodeRect,
  type SceneFile,
  type SceneNode,
} from "@/lib/studio/document"

/**
 * The game itself, in an iframe, with the editor's selection and drag
 * handles laid over it.
 *
 * There is no second renderer: the iframe runs `outputs/game/index.html`
 * from the backend's project server, so what the user drags is what the
 * engine draws. Each node's box is placed from the same transform math the
 * engine uses (`nodeRect`), scaled to the iframe's on-screen size.
 *
 * Live updates use the engine contract: the engine posts `codeg:ready`
 * with `hot: true` when it can re-render a document posted as
 * `codeg:scene`; the stage then posts every edit immediately. An engine
 * without hot reload (`hot: false`) is reloaded by the parent after each
 * save through `reloadToken`.
 *
 * Edit vs play: the iframe always loads with `?codeg=edit`, and an engine
 * that announces `modes: true` (the managed `codeg-engine`) is told
 * `codeg:mode` whenever the toolbar toggles. In edit mode it pauses scripts
 * and input and draws the document as written, so the overlay boxes match
 * what is on screen; play mode restarts the game from the document. Engines
 * without modes simply keep running underneath the overlay.
 */
export interface StudioStageProps {
  /** Full URL of the game entry with `?scene=` already applied. `null`
   *  while the preview server is being resolved. */
  src: string | null
  scene: SceneFile
  selectedId: string | null
  playing: boolean
  /** Bump to force the iframe to reload (agent edits, non-hot engines). */
  reloadToken: number
  onSelect: (id: string | null) => void
  onMove: (id: string, x: number, y: number) => void
  /** Engine announced itself; `hot` says whether it accepts `codeg:scene`. */
  onReady: (hot: boolean) => void
  /** The engine reported a runtime problem (`codeg:error`): an exception, a
   *  rejected promise, a `console.error`. Collected so it can be handed to
   *  the agent. */
  onEngineError?: (message: string) => void
  /** Desktop loopback iframes keep their real origin; web ones run opaque. */
  sameOrigin: boolean
}

export function StudioStage({
  src,
  scene,
  selectedId,
  playing,
  reloadToken,
  onSelect,
  onMove,
  onReady,
  onEngineError,
  sameOrigin,
}: StudioStageProps) {
  const t = useTranslations("Studio")
  const area = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const hot = useRef(false)
  const modes = useRef(false)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const { width: W, height: H } = scene.document.container

  // Fit the container's aspect into the available area.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const fit = () => {
      const bw = el.clientWidth
      const bh = el.clientHeight
      const scale = Math.min(bw / W, bh / H)
      setSize({
        w: Math.max(1, Math.floor(W * scale)),
        h: Math.max(1, Math.floor(H * scale)),
      })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [W, H])

  const post = useCallback((message: unknown) => {
    frame.current?.contentWindow?.postMessage(message, "*")
  }, [])

  // Engine handshake.
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as {
        type?: string
        hot?: boolean
        modes?: boolean
        message?: unknown
      } | null
      if (data?.type === "codeg:error") {
        if (typeof data.message === "string" && data.message.trim())
          onEngineError?.(data.message.slice(0, 2000))
        return
      }
      if (data?.type !== "codeg:ready") return
      hot.current = data.hot === true
      modes.current = data.modes === true
      onReady(hot.current)
      if (modes.current)
        post({
          type: "codeg:mode",
          mode: playingRef.current ? "play" : "edit",
        })
      if (hot.current) post({ type: "codeg:scene", scene })
    }
    window.addEventListener("message", listen)
    return () => window.removeEventListener("message", listen)
    // `scene` is read at handshake time only; later edits go through the
    // effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReady, onEngineError, post])

  // Every edit, straight into the running engine.
  useEffect(() => {
    if (hot.current) post({ type: "codeg:scene", scene })
  }, [scene, post])

  // Toolbar toggle → engine mode. Leaving play mode also resets the game to
  // the document, which is what "back to editing" should look like.
  useEffect(() => {
    if (modes.current)
      post({ type: "codeg:mode", mode: playing ? "play" : "edit" })
  }, [playing, post])

  // A reload invalidates the handshake until the engine announces again.
  useEffect(() => {
    hot.current = false
    modes.current = false
  }, [reloadToken, src])

  // Drag: pointer capture on the node box; deltas in container pixels.
  const drag = useRef<{
    id: string
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const scale = size.w / W

  const url = src
    ? `${src}${src.includes("?") ? "&" : "?"}codeg=edit&r=${reloadToken}`
    : null
  const nodes = [...scene.document.nodes].sort(
    (a, b) => a.transform.z - b.transform.z
  )

  return (
    <div ref={area} className="studio-stage-area">
      <div
        className="studio-stage"
        style={{ width: size.w, height: size.h }}
        data-playing={playing || undefined}
      >
        {url ? (
          <iframe
            ref={frame}
            src={url}
            title={t("gameView")}
            className="studio-stage-frame"
            sandbox={
              sameOrigin
                ? "allow-scripts allow-same-origin allow-pointer-lock allow-forms"
                : "allow-scripts allow-pointer-lock allow-forms"
            }
            allow="autoplay; fullscreen; gamepad"
          />
        ) : (
          <div className="studio-stage-empty">{t("previewStarting")}</div>
        )}
        {!playing && (
          <div
            className="studio-overlay"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) onSelect(null)
            }}
          >
            {nodes.map((node: SceneNode) => {
              const r = nodeRect(scene.document, node)
              const hidden = !isVisible(node)
              return (
                <div
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={node.id}
                  aria-pressed={selectedId === node.id}
                  className="studio-overlay-node"
                  data-selected={selectedId === node.id || undefined}
                  data-hidden={hidden || undefined}
                  style={{
                    left: r.x * scale,
                    top: r.y * scale,
                    width: Math.max(2, r.w * scale),
                    height: Math.max(2, r.h * scale),
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onSelect(node.id)
                    }
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    onSelect(node.id)
                    event.currentTarget.setPointerCapture(event.pointerId)
                    drag.current = {
                      id: node.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      originX: node.transform.x,
                      originY: node.transform.y,
                      moved: false,
                    }
                  }}
                  onPointerMove={(event) => {
                    const d = drag.current
                    if (!d || d.id !== node.id || scale === 0) return
                    const dx = (event.clientX - d.startX) / scale
                    const dy = (event.clientY - d.startY) / scale
                    if (!d.moved && Math.hypot(dx, dy) < 2) return
                    d.moved = true
                    onMove(
                      node.id,
                      Math.round(d.originX + dx),
                      Math.round(d.originY + dy)
                    )
                  }}
                  onPointerUp={(event) => {
                    if (drag.current?.id === node.id) drag.current = null
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }}
                  onPointerCancel={() => {
                    drag.current = null
                  }}
                >
                  <span className="studio-overlay-label">{node.id}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
