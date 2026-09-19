"use client"

import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Canvas, useThree } from "@react-three/fiber"
import {
  Color,
  OrthographicCamera,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from "three"
import { useTranslations } from "next-intl"
import type { StudioDocument, StudioNode } from "@/lib/studio/document"

function FitCamera({ width, height }: { width: number; height: number }) {
  const { camera, size, invalidate } = useThree()
  useLayoutEffect(() => {
    if (camera instanceof OrthographicCamera) {
      // Three.js cameras are mutable engine objects; R3F exposes this imperative API.
      // eslint-disable-next-line react-hooks/immutability
      camera.zoom = Math.min(size.width / width, size.height / height)
      camera.updateProjectionMatrix()
      invalidate()
    }
  }, [camera, size, width, height, invalidate])
  return null
}

function ImageMaterial({ blob, color }: { blob?: Blob; color: string }) {
  const [texture, setTexture] = useState<Texture | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const { invalidate } = useThree()
  useEffect(() => {
    if (!blob) return
    let disposed = false
    const url = URL.createObjectURL(blob)
    // Let pending image requests settle before revoking their URL, including
    // React StrictMode's setup/cleanup/setup cycle and removed image nodes.
    const loaded = new TextureLoader().load(
      url,
      (value) => {
        URL.revokeObjectURL(url)
        if (disposed) {
          value.dispose()
          return
        }
        value.colorSpace = SRGBColorSpace
        setTexture(value)
        invalidate()
      },
      undefined,
      () => {
        URL.revokeObjectURL(url)
        if (!disposed) setLoadFailed(true)
      }
    )
    return () => {
      disposed = true
      loaded.dispose()
    }
  }, [blob, invalidate])
  if (loadFailed) throw new Error("Cannot load the scene image")
  return (
    <meshBasicMaterial
      // Adding a map changes shader defines; recreate after asynchronous loading.
      key={texture?.uuid ?? "loading"}
      map={texture}
      color={color}
      transparent
      depthTest={false}
      toneMapped={false}
    />
  )
}

class RenderBoundary extends Component<
  { children: ReactNode; message: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <div className="studio-render-error" role="alert">
          {this.props.message}
        </div>
      )
    return this.props.children
  }
}

interface Props {
  document: StudioDocument
  blobs: Map<string, Blob>
  selectedId: string | null
  playing: boolean
  onSelect: (id: string | null) => void
  onMove: (id: string, x: number, y: number) => void
}

export function StudioViewport({
  document,
  blobs,
  selectedId,
  playing,
  onSelect,
  onMove,
}: Props) {
  const t = useTranslations("Studio")
  const container = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState<{
    id: string
    x: number
    y: number
  } | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const drag = useRef<{
    id: string
    x: number
    y: number
    clientX: number
    clientY: number
    scale: number
    moved: boolean
  } | null>(null)
  const moveCallback = useRef(onMove)
  moveCallback.current = onMove

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current
      if (!current) return
      const dx = (event.clientX - current.clientX) * current.scale
      const dy = (event.clientY - current.clientY) * current.scale
      current.moved ||= Math.abs(dx) + Math.abs(dy) > 2
      if (current.moved)
        setOffset({
          id: current.id,
          x: Math.round(Math.max(-8192, Math.min(8192, current.x + dx))),
          y: Math.round(Math.max(-8192, Math.min(8192, current.y + dy))),
        })
    }
    const end = (event: PointerEvent) => {
      const current = drag.current
      if (!current) return
      if (current.moved && event.type !== "pointercancel") {
        const x = Math.round(
          Math.max(
            -8192,
            Math.min(
              8192,
              current.x + (event.clientX - current.clientX) * current.scale
            )
          )
        )
        const y = Math.round(
          Math.max(
            -8192,
            Math.min(
              8192,
              current.y + (event.clientY - current.clientY) * current.scale
            )
          )
        )
        moveCallback.current(current.id, x, y)
      }
      drag.current = null
      setOffset(null)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
    }
  }, [])

  function begin(
    node: StudioNode,
    event: { clientX: number; clientY: number; button: number }
  ) {
    if (event.button !== 0 || playing) return
    onSelect(node.id)
    const bounds = container.current?.getBoundingClientRect()
    if (bounds)
      drag.current = {
        id: node.id,
        x: node.x,
        y: node.y,
        clientX: event.clientX,
        clientY: event.clientY,
        scale: document.width / bounds.width,
        moved: false,
      }
  }
  function activate(node: StudioNode) {
    if (!playing || !node.toggleTarget) return
    const target = node.toggleTarget
    setHidden((previous) => {
      const next = new Set(previous)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  return (
    <div className="studio-stage-shell">
      <div
        className="studio-stage"
        ref={container}
        style={{ aspectRatio: `${document.width} / ${document.height}` }}
        aria-label={t("viewport")}
      >
        <RenderBoundary message={t("webglError")}>
          <Canvas
            orthographic
            camera={{ position: [0, 0, 1000], near: 0.1, far: 2000 }}
            frameloop="demand"
            dpr={[1, 2]}
            gl={{ antialias: true, preserveDrawingBuffer: true }}
            fallback={<p role="alert">{t("webglError")}</p>}
            onPointerMissed={() => !playing && onSelect(null)}
          >
            <color attach="background" args={[document.background]} />
            <FitCamera width={document.width} height={document.height} />
            {document.nodes.map((node, index) => {
              const visible = hidden.has(node.id) ? !node.visible : node.visible
              if (!visible) return null
              const x = offset?.id === node.id ? offset.x : node.x
              const y = offset?.id === node.id ? offset.y : node.y
              return (
                <group
                  key={node.id}
                  position={[
                    x + node.width / 2 - document.width / 2,
                    document.height / 2 - y - node.height / 2,
                    index * 2,
                  ]}
                >
                  {!playing && selectedId === node.id && (
                    <mesh renderOrder={index * 2}>
                      <planeGeometry args={[node.width + 5, node.height + 5]} />
                      <meshBasicMaterial
                        color="#ffffff"
                        depthTest={false}
                        toneMapped={false}
                      />
                    </mesh>
                  )}
                  <mesh
                    renderOrder={index * 2 + 1}
                    scale={
                      node.kind === "ellipse"
                        ? [node.width / 2, node.height / 2, 1]
                        : [1, 1, 1]
                    }
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      begin(node, event.nativeEvent)
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      activate(node)
                    }}
                  >
                    {node.kind === "ellipse" ? (
                      <circleGeometry args={[1, 64]} />
                    ) : (
                      <planeGeometry args={[node.width, node.height]} />
                    )}
                    {node.kind === "image" ? (
                      <ImageMaterial
                        blob={blobs.get(node.assetId ?? "")}
                        color={node.color}
                      />
                    ) : (
                      <meshBasicMaterial
                        color={new Color(node.color)}
                        depthTest={false}
                        toneMapped={false}
                      />
                    )}
                  </mesh>
                </group>
              )
            })}
          </Canvas>
        </RenderBoundary>
      </div>
      {playing && (
        <div className="studio-preview-actions" aria-label={t("interactions")}>
          {document.nodes
            .filter(
              (node) =>
                node.toggleTarget &&
                (hidden.has(node.id) ? !node.visible : node.visible)
            )
            .map((node) => (
              <button key={node.id} onClick={() => activate(node)}>
                {node.name}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
