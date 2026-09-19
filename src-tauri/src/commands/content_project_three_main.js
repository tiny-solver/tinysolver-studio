// three-web engine v0.2.0 — 장면 러너.
//
// 장면 데이터는 ../content/<scene>.studio.json 이고, Codeg Studio 편집기가
// 같은 파일을 편집한다. 이 파일은 그리기와 클릭만 담당한다. 게임 규칙을
// 추가할 때도 아래 두 가지는 유지한다. 편집기가 이 계약으로 미리보기를 띄운다.
//
//   1. `?scene=<id>` 로 장면을 고른다 (기본 main).
//   2. 로드되면 parent 에 `codeg:ready` 를 보내고, `codeg:scene` 으로 받은
//      문서를 다시 그린다 (hot: true). 다시 그릴 수 없게 바뀌면 hot: false.
//
// 좌표계: 컨테이너 픽셀, 원점 좌상단, y 아래 방향.
import * as THREE from "three"

const params = new URLSearchParams(location.search)
const SCENE_ID = /^[a-zA-Z0-9_-]{1,100}$/.test(params.get("scene") || "")
  ? params.get("scene")
  : "main"
const SCENE_URL = new URL(`../content/${SCENE_ID}.studio.json`, import.meta.url)
const ASSET_BASE = new URL("../../../assets/", import.meta.url)

// ── 렌더러 ────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true })
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0d14)
let camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 2000)
camera.position.z = 500

let container = { width: 1080, height: 1920 }
function resize() {
  const scale = Math.min(
    innerWidth / container.width,
    innerHeight / container.height
  )
  const w = Math.max(1, Math.floor(container.width * scale))
  const h = Math.max(1, Math.floor(container.height * scale))
  renderer.setPixelRatio(devicePixelRatio)
  renderer.setSize(w, h)
  const el = renderer.domElement
  el.style.position = "absolute"
  el.style.left = `${Math.floor((innerWidth - w) / 2)}px`
  el.style.top = `${Math.floor((innerHeight - h) / 2)}px`
}
addEventListener("resize", resize)

// ── 텍스처 ────────────────────────────────────────────────────────
const loader = new THREE.TextureLoader()
const textures = new Map()
const reported = new Set()
function textureFor(assets, assetId) {
  const a = assets.get(assetId)
  if (!a || a.missing) {
    if (assetId && !reported.has(assetId)) {
      reported.add(assetId)
      console.warn(`[asset missing] ${assetId} → 플레이스홀더로 대체`)
    }
    return null
  }
  if (!textures.has(a.file)) {
    const t = loader.load(new URL(a.file, ASSET_BASE).href)
    t.colorSpace = THREE.SRGBColorSpace
    t.magFilter = THREE.NearestFilter
    textures.set(a.file, t)
  }
  return textures.get(a.file)
}

function textTexture(props, w, h) {
  const c = document.createElement("canvas")
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  const g = c.getContext("2d")
  const size = props.size || 44
  g.fillStyle = props.color || "#ffffff"
  g.font = `${size}px sans-serif`
  g.textBaseline = "top"
  g.textAlign =
    props.align === "center"
      ? "center"
      : props.align === "right"
        ? "right"
        : "left"
  const x = props.align === "center" ? w / 2 : props.align === "right" ? w : 0
  let y = 0
  for (const paragraph of String(props.text ?? "").split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word
      if (g.measureText(test).width > w && line) {
        g.fillText(line, x, y)
        y += size * 1.4
        line = word
      } else line = test
    }
    g.fillText(line, x, y)
    y += size * 1.4
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ── 장면 ──────────────────────────────────────────────────────────
let doc = null
let nodes = new Map()
let meshes = new Map()

function topLeftOf(node) {
  const t = node.transform
  let x = t.x
  let y = t.y
  if (t.anchor === "bottom-center") {
    x -= t.w / 2
    y -= t.h
  } else if (t.anchor === "center") {
    x -= t.w / 2
    y -= t.h / 2
  }
  const parent = nodes.get(node.parent)
  if (parent && parent !== node) {
    const p = topLeftOf(parent)
    x += p.x
    y += p.y
  }
  return { x, y }
}

function clearScene() {
  for (const mesh of meshes.values()) {
    scene.remove(mesh)
    mesh.geometry.dispose()
    if (mesh.material.map instanceof THREE.CanvasTexture)
      mesh.material.map.dispose()
    mesh.material.dispose()
  }
  meshes = new Map()
}

function buildNode(assets, node) {
  const t = node.transform
  const p = node.props || {}
  let material
  if (node.type === "text") {
    material = new THREE.MeshBasicMaterial({
      map: textTexture(p, t.w, t.h),
      transparent: true,
      side: THREE.DoubleSide,
    })
  } else if (node.type === "rect") {
    material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color || "#888888"),
      side: THREE.DoubleSide,
    })
  } else {
    const tex = textureFor(assets, p.asset)
    material = tex
      ? new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshBasicMaterial({
          color: new THREE.Color(p.placeholder || "#ff00ff"),
          transparent: true,
          opacity: 0.95,
          side: THREE.DoubleSide,
        })
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(t.w, t.h), material)
  mesh.scale.y = -1 // 카메라가 y를 뒤집었으므로 평면도 뒤집는다.
  const tl = topLeftOf(node)
  mesh.position.set(tl.x + t.w / 2, tl.y + t.h / 2, t.z || 0)
  mesh.visible = p.visible !== false
  scene.add(mesh)
  meshes.set(node.id, mesh)
}

function applyScene(next) {
  doc = next
  const D = doc.document
  container = D.container || container
  camera = new THREE.OrthographicCamera(
    0,
    container.width,
    0,
    container.height,
    0.1,
    2000
  )
  camera.position.z = 500
  resize()
  clearScene()
  nodes = new Map((D.nodes || []).map((n) => [n.id, n]))
  const assets = new Map((D.assets || []).map((a) => [a.id, a]))
  for (const node of D.nodes || []) buildNode(assets, node)
}

// ── 동작 ──────────────────────────────────────────────────────────
const toast = document.createElement("div")
toast.style.cssText =
  "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);max-width:80%;padding:12px 18px;border-radius:8px;background:#151826ee;color:#f2efe6;font:20px/1.4 sans-serif;display:none;pointer-events:none"
document.body.appendChild(toast)
let toastTimer = 0
function say(text) {
  toast.textContent = text
  toast.style.display = "block"
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.style.display = "none"), 2200)
}

const ops = {
  toggle({ id }) {
    const mesh = meshes.get(id)
    if (mesh) mesh.visible = !mesh.visible
  },
  setVisible({ id, value }) {
    const mesh = meshes.get(id)
    if (mesh) mesh.visible = !!value
  },
  say({ text }) {
    say(String(text ?? ""))
  },
  swapAsset({ id, asset }) {
    const node = nodes.get(id)
    const mesh = meshes.get(id)
    if (!node || !mesh) return
    node.props.asset = asset
    const tex = textureFor(
      new Map((doc.document.assets || []).map((a) => [a.id, a])),
      asset
    )
    if (tex) {
      mesh.material.map = tex
      mesh.material.color.set(0xffffff)
      mesh.material.needsUpdate = true
    }
  },
  goto({ scene: target }) {
    if (/^[a-zA-Z0-9_-]{1,100}$/.test(String(target))) {
      const url = new URL(location.href)
      url.searchParams.set("scene", target)
      location.href = url.href
    }
  },
}

function runAction(name) {
  const steps = doc?.logic?.actions?.[name]
  if (!Array.isArray(steps)) {
    console.warn(`[action] ${name}: logic.actions 에 정의가 없다`)
    return
  }
  for (const step of steps) ops[step.op]?.(step)
}

function hitTest(px, py) {
  const ordered = [...nodes.values()].sort(
    (a, b) => (b.transform.z || 0) - (a.transform.z || 0)
  )
  for (const node of ordered) {
    if (!node.props?.interactive) continue
    if (!meshes.get(node.id)?.visible) continue
    const tl = topLeftOf(node)
    const t = node.transform
    if (px >= tl.x && px <= tl.x + t.w && py >= tl.y && py <= tl.y + t.h)
      return node
  }
  return null
}

renderer.domElement.addEventListener("pointerdown", (e) => {
  const rect = renderer.domElement.getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * container.width
  const py = ((e.clientY - rect.top) / rect.height) * container.height
  const hit = hitTest(px, py)
  if (hit?.props.onClick) runAction(hit.props.onClick)
})

// ── 편집기 연결 ───────────────────────────────────────────────────
addEventListener("message", (e) => {
  const m = e.data
  if (!m || typeof m !== "object") return
  if (m.type === "codeg:scene" && m.scene?.document) applyScene(m.scene)
  else if (m.type === "codeg:reload") location.reload()
})

// ── 시작 ──────────────────────────────────────────────────────────
try {
  applyScene(
    await fetch(SCENE_URL).then((r) =>
      r.ok
        ? r.json()
        : Promise.reject(new Error(`${r.status} ${SCENE_URL.pathname}`))
    )
  )
} catch (err) {
  console.error("[scene] 장면을 읽지 못했다:", err)
  say(`장면을 읽지 못했다: ${err.message}`)
}
parent.postMessage({ type: "codeg:ready", hot: true, scene: SCENE_ID }, "*")

renderer.setAnimationLoop(() => renderer.render(scene, camera))
