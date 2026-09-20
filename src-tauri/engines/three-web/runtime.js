// codeg-engine · three-web runtime v0.3.0
//
// Codeg Studio 가 제공하는 2D 장면 런타임이다. 프로젝트에 복사되지 않는다.
// 미리보기 서버가 `__codeg/engine/three-web/runtime.js` 로 서빙하고, 빌드가
// 같은 상대 경로에 넣어 준다. 프로젝트의 index.html 은 importmap 으로
// `codeg-engine` 을 이 파일에 연결한다. API 설명은 같은 폴더의 ENGINE.md.
//
// 편집기 계약:
//   1. `?scene=<id>` 로 장면을 고른다 (기본 main). `?codeg=edit` 면 편집 모드로 시작.
//   2. 로드되면 parent 에 `codeg:ready { hot: true, modes: true }` 를 보낸다.
//   3. `codeg:scene { scene }` → 받은 문서를 다시 그린다.
//      `codeg:mode { mode: "edit" | "play" }` → 모드 전환. 편집 모드에서는
//      스크립트·행동·입력이 멈추고 장면이 문서 그대로 그려진다.
//
// 좌표계: 컨테이너 픽셀, 원점 좌상단, y 아래 방향.
import * as THREE from "three"

export const VERSION = "0.3.0"
export { THREE }

const ID = /^[a-zA-Z0-9_-]{1,100}$/

/** Easing functions for `engine.tween` and the built-in behaviors. */
export const ease = {
  linear: (t) => t,
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
}

/**
 * Start the game. `options`:
 *   scripts  { name: (node, engine) => ({ update(dt), onClick(), dispose() }) }
 *            attached to nodes whose `props.script` names them (string or list)
 *   ops      { name: (step, engine) => void }  extra `logic.actions` operations
 *   setup    (engine) => void  called every time the game (re)starts in play
 *            mode: first load, entering play, reset(), a hot scene update.
 *            `engine.state` and `engine.on` listeners are cleared before it.
 *   scene, contentBase, assetBase  overrides for unusual layouts
 */
export async function start(options = {}) {
  const params = new URLSearchParams(location.search)
  const requested = params.get("scene") || ""
  let sceneId = ID.test(requested) ? requested : options.scene || "main"
  const contentBase = new URL(
    options.contentBase ?? "./content/",
    document.baseURI
  )
  const assetBase = new URL(
    options.assetBase ?? "../../assets/",
    document.baseURI
  )
  const embedded = window.parent !== window
  let mode = params.get("codeg") === "edit" ? "edit" : "play"

  // ── 렌더러 ──────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  document.body.appendChild(renderer.domElement)
  const world = new THREE.Scene()
  world.background = new THREE.Color(0x0b0d14)
  let camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 4000)
  camera.position.z = 2000
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

  // ── 텍스처 ──────────────────────────────────────────────────────
  const loader = new THREE.TextureLoader()
  const textures = new Map()
  const reported = new Set()
  let assets = new Map()

  function textureFor(assetId) {
    const a = assets.get(assetId)
    if (!a || a.missing) {
      if (assetId && !reported.has(assetId)) {
        reported.add(assetId)
        console.warn(`[asset missing] ${assetId} → 플레이스홀더로 대체`)
      }
      return null
    }
    if (!textures.has(a.file)) {
      const t = loader.load(new URL(a.file, assetBase).href)
      t.colorSpace = THREE.SRGBColorSpace
      t.magFilter = a.smooth ? THREE.LinearFilter : THREE.NearestFilter
      textures.set(a.file, t)
    }
    return textures.get(a.file)
  }

  function textTexture(props, w, h) {
    const c = document.createElement("canvas")
    c.width = Math.max(1, Math.round(w))
    c.height = Math.max(1, Math.round(h))
    const g = c.getContext("2d")
    const size = props.size || 44
    g.fillStyle = props.color || "#ffffff"
    g.font = `${props.weight || "normal"} ${size}px ${props.font || "sans-serif"}`
    g.textBaseline = "top"
    const align =
      props.align === "center" || props.align === "right" ? props.align : "left"
    g.textAlign = align
    const x = align === "center" ? w / 2 : align === "right" ? w : 0
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

  // ── 장면 ────────────────────────────────────────────────────────
  let source = null // 받은 문서 그대로. 모드 전환·reset 의 기준.
  let doc = null // 실행 중에 바뀌는 사본.
  let nodes = new Map()
  let meshes = new Map()
  let instances = [] // { id, name, api }
  let tweens = []
  const handles = new Map()
  const listeners = new Map()

  function emit(event, payload) {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(payload)
      } catch (err) {
        console.error(`[engine] "${event}" 리스너 오류:`, err)
      }
    }
  }

  function topLeftOf(node, seen = new Set()) {
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
    seen.add(node.id)
    const parent = nodes.get(node.parent)
    if (parent && !seen.has(parent.id)) {
      const p = topLeftOf(parent, seen)
      x += p.x
      y += p.y
    }
    return { x, y }
  }

  function disposeMesh(mesh) {
    world.remove(mesh)
    mesh.geometry.dispose()
    if (mesh.material.map instanceof THREE.CanvasTexture)
      mesh.material.map.dispose()
    mesh.material.dispose()
  }

  function materialFor(node) {
    const t = node.transform
    const p = node.props || {}
    const opacity = typeof p.opacity === "number" ? p.opacity : 1
    if (node.type === "text")
      return new THREE.MeshBasicMaterial({
        map: textTexture(p, t.w, t.h),
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
      })
    if (node.type === "rect")
      return new THREE.MeshBasicMaterial({
        color: new THREE.Color(p.color || "#888888"),
        transparent: opacity < 1,
        opacity,
        side: THREE.DoubleSide,
      })
    const tex = textureFor(p.asset)
    return tex
      ? new THREE.MeshBasicMaterial({
          map: tex,
          color: new THREE.Color(p.tint || "#ffffff"),
          transparent: true,
          opacity,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshBasicMaterial({
          color: new THREE.Color(p.placeholder || "#ff00ff"),
          transparent: true,
          opacity: 0.95 * opacity,
          side: THREE.DoubleSide,
        })
  }

  function place(node) {
    const mesh = meshes.get(node.id)
    if (!mesh) return
    const t = node.transform
    const tl = topLeftOf(node)
    mesh.position.set(tl.x + t.w / 2, tl.y + t.h / 2, t.z || 0)
    const p = node.props || {}
    const sx = (typeof p.scale === "number" ? p.scale : 1) * (p.flipX ? -1 : 1)
    const sy = typeof p.scale === "number" ? p.scale : 1
    mesh.scale.set(sx, -sy, 1) // 카메라가 y를 뒤집었으므로 평면도 뒤집는다.
    mesh.rotation.z = -((p.rotation || 0) * Math.PI) / 180
    mesh.visible = p.visible !== false
  }

  function buildNode(node) {
    const old = meshes.get(node.id)
    if (old) disposeMesh(old)
    const t = node.transform
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(t.w, t.h),
      materialFor(node)
    )
    world.add(mesh)
    meshes.set(node.id, mesh)
    place(node)
  }

  /** Re-place a node and everything parented to it. */
  function sync(id) {
    const node = nodes.get(id)
    if (!node) return
    place(node)
    for (const child of nodes.values())
      if (child.parent === id && child.id !== id) sync(child.id)
  }

  // 플레이 중의 게임 변수를 편집기에 보여 준다. 스크립트가 engine.state 를 직접
  // 고쳐도 잡히도록 주기적으로 비교한다.
  let sentState = null
  function reportState() {
    if (!embedded) return
    let text
    try {
      text = JSON.stringify(engine.state)
    } catch {
      return
    }
    if (text === sentState || text.length > 20000) return
    sentState = text
    parent.postMessage(
      { type: "codeg:state", mode, state: JSON.parse(text) },
      "*"
    )
  }

  // ── 스크립트 ────────────────────────────────────────────────────
  const scripts = { ...builtinScripts, ...(options.scripts || {}) }

  function stopScripts() {
    for (const inst of instances) {
      try {
        inst.api?.dispose?.()
      } catch (err) {
        console.error(`[script ${inst.name}] dispose 오류:`, err)
      }
    }
    instances = []
    tweens = []
  }

  function startScripts() {
    for (const node of nodes.values()) {
      const wanted = node.props?.script
      const names = Array.isArray(wanted) ? wanted : wanted ? [wanted] : []
      for (const entry of names) {
        // "float" 또는 { name: "float", amplitude: 12 }
        const name = typeof entry === "string" ? entry : entry?.name
        const config = typeof entry === "object" && entry ? entry : {}
        const factory = scripts[name]
        if (typeof factory !== "function") {
          console.error(
            `[script] "${name}" 이 없다 (node ${node.id}). src/scripts/index.js 의 scripts 에 등록한다.`
          )
          continue
        }
        try {
          const api = factory(handle(node.id), engine, config) || {}
          instances.push({ id: node.id, name, api })
        } catch (err) {
          console.error(`[script ${name}] 시작 오류 (node ${node.id}):`, err)
        }
      }
    }
  }

  function applyScene(next) {
    source = next
    doc = structuredClone(next)
    const D = doc.document
    container = D.container || container
    camera = new THREE.OrthographicCamera(
      0,
      container.width,
      0,
      container.height,
      0.1,
      4000
    )
    camera.position.z = 2000
    resize()
    stopScripts()
    for (const mesh of meshes.values()) disposeMesh(mesh)
    meshes = new Map()
    handles.clear()
    nodes = new Map((D.nodes || []).map((n) => [n.id, n]))
    assets = new Map((D.assets || []).map((a) => [a.id, a]))
    for (const node of nodes.values()) buildNode(node)
    // 게임이 (다시) 시작한다: 변수와 리스너를 비우고, 플레이 모드면 setup 과
    // 스크립트를 처음부터 돌린다. 편집 모드에서는 아무것도 돌지 않는다.
    engine.state = {}
    listeners.clear()
    if (mode === "play") {
      try {
        options.setup?.(engine)
      } catch (err) {
        console.error("[engine] setup 오류:", err)
      }
      startScripts()
    }
    emit("scene", doc)
    reportState()
  }

  // ── 노드 핸들 ───────────────────────────────────────────────────
  function handle(id) {
    if (handles.has(id)) return handles.get(id)
    const node = nodes.get(id)
    if (!node) return null
    const h = {
      get id() {
        return node.id
      },
      get data() {
        return node
      },
      get props() {
        return node.props
      },
      get mesh() {
        return meshes.get(node.id)
      },
      get x() {
        return node.transform.x
      },
      set x(v) {
        node.transform.x = v
        sync(node.id)
      },
      get y() {
        return node.transform.y
      },
      set y(v) {
        node.transform.y = v
        sync(node.id)
      },
      get w() {
        return node.transform.w
      },
      get h() {
        return node.transform.h
      },
      get z() {
        return node.transform.z || 0
      },
      set z(v) {
        node.transform.z = v
        sync(node.id)
      },
      get visible() {
        return node.props.visible !== false
      },
      set visible(v) {
        node.props.visible = !!v
        place(node)
      },
      /** Absolute top-left box in container pixels. */
      get rect() {
        const tl = topLeftOf(node)
        return { x: tl.x, y: tl.y, w: node.transform.w, h: node.transform.h }
      },
      moveTo(x, y) {
        node.transform.x = x
        node.transform.y = y
        sync(node.id)
        return h
      },
      moveBy(dx, dy) {
        return h.moveTo(node.transform.x + dx, node.transform.y + dy)
      },
      /** Change any props and redraw (asset, text, color, opacity, rotation, scale, flipX…). */
      set(patch) {
        Object.assign(node.props, patch)
        buildNode(node)
        return h
      },
      setAsset(assetId) {
        return h.set({ asset: assetId })
      },
      setText(text) {
        return h.set({ text: String(text) })
      },
      overlaps(other) {
        const o = typeof other === "string" ? handle(other) : other
        if (!o || !o.visible || !h.visible) return false
        const a = h.rect
        const b = o.rect
        return (
          a.x < b.x + b.w &&
          a.x + a.w > b.x &&
          a.y < b.y + b.h &&
          a.y + a.h > b.y
        )
      },
      tween(to, opts) {
        return engine.tween(h, to, opts)
      },
    }
    handles.set(id, h)
    return h
  }

  // ── 동작 ────────────────────────────────────────────────────────
  const toast = document.createElement("div")
  toast.style.cssText =
    "position:fixed;left:50%;bottom:8%;transform:translateX(-50%);max-width:80%;padding:12px 18px;border-radius:8px;background:#151826ee;color:#f2efe6;font:20px/1.4 sans-serif;display:none;pointer-events:none;z-index:10"
  document.body.appendChild(toast)
  let toastTimer = 0
  function say(text, ms = 2200) {
    toast.textContent = String(text ?? "")
    toast.style.display = "block"
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.style.display = "none"), ms)
  }

  function goto(target) {
    if (!ID.test(String(target))) return
    const url = new URL(location.href)
    url.searchParams.set("scene", target)
    location.href = url.href
  }

  const ops = {
    toggle: ({ id }) => {
      const h = handle(id)
      if (h) h.visible = !h.visible
    },
    setVisible: ({ id, value }) => {
      const h = handle(id)
      if (h) h.visible = !!value
    },
    say: ({ text }) => say(text),
    swapAsset: ({ id, asset }) => handle(id)?.setAsset(asset),
    setText: ({ id, text }) => handle(id)?.setText(text),
    move: ({ id, x, y, by, duration }) => {
      const h = handle(id)
      if (!h) return
      const to = by
        ? { x: h.x + (x || 0), y: h.y + (y || 0) }
        : { x: x ?? h.x, y: y ?? h.y }
      if (duration) h.tween(to, { duration })
      else h.moveTo(to.x, to.y)
    },
    set: ({ key, value }) => {
      engine.state[key] = value
      emit("state", engine.state)
    },
    add: ({ key, value }) => {
      engine.state[key] =
        (Number(engine.state[key]) || 0) + (Number(value) || 0)
      emit("state", engine.state)
    },
    goto: ({ scene }) => goto(scene),
    run: ({ action }) => run(action),
    ...(options.ops || {}),
  }

  function run(name) {
    const steps = doc?.logic?.actions?.[name]
    if (!Array.isArray(steps)) {
      console.warn(`[action] ${name}: logic.actions 에 정의가 없다`)
      return
    }
    for (const step of steps) {
      // { if: { key, equals | atLeast }, ... } 로 조건을 건다.
      if (step.if && !test(step.if)) continue
      const op = ops[step.op]
      if (!op) {
        console.error(
          `[action ${name}] 모르는 op "${step.op}". start({ ops }) 로 등록한다.`
        )
        continue
      }
      try {
        op(step, engine)
      } catch (err) {
        console.error(`[action ${name}] op "${step.op}" 오류:`, err)
      }
    }
  }

  function test(cond) {
    const value = engine.state[cond.key]
    if ("equals" in cond) return value === cond.equals
    if ("atLeast" in cond) return Number(value) >= Number(cond.atLeast)
    if ("not" in cond) return value !== cond.not
    return Boolean(value)
  }

  // ── 입력 ────────────────────────────────────────────────────────
  const pressed = new Set()
  const input = {
    /** `engine.input.down("ArrowLeft")` — matches `event.key` or `event.code`. */
    down: (key) => pressed.has(key),
    pointer: { x: 0, y: 0, down: false },
    /** -1 | 0 | 1 from arrows / WASD. */
    get axisX() {
      return (
        (pressed.has("ArrowRight") || pressed.has("KeyD") ? 1 : 0) -
        (pressed.has("ArrowLeft") || pressed.has("KeyA") ? 1 : 0)
      )
    },
    get axisY() {
      return (
        (pressed.has("ArrowDown") || pressed.has("KeyS") ? 1 : 0) -
        (pressed.has("ArrowUp") || pressed.has("KeyW") ? 1 : 0)
      )
    },
  }
  addEventListener("keydown", (e) => {
    if (mode !== "play") return
    pressed.add(e.key)
    pressed.add(e.code)
    emit("keydown", e)
  })
  addEventListener("keyup", (e) => {
    pressed.delete(e.key)
    pressed.delete(e.code)
    if (mode === "play") emit("keyup", e)
  })
  addEventListener("blur", () => pressed.clear())

  function toContainer(e) {
    const rect = renderer.domElement.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * container.width,
      y: ((e.clientY - rect.top) / rect.height) * container.height,
    }
  }

  function hitTest(px, py) {
    const ordered = [...nodes.values()].sort(
      (a, b) => (b.transform.z || 0) - (a.transform.z || 0)
    )
    for (const node of ordered) {
      if (!node.props?.interactive) continue
      if (node.props.visible === false) continue
      const tl = topLeftOf(node)
      const t = node.transform
      if (px >= tl.x && px <= tl.x + t.w && py >= tl.y && py <= tl.y + t.h)
        return node
    }
    return null
  }

  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (mode !== "play") return
    window.focus()
    const p = toContainer(e)
    Object.assign(input.pointer, p, { down: true })
    const hit = hitTest(p.x, p.y)
    emit("pointerdown", { ...p, node: hit ? handle(hit.id) : null })
    if (!hit) return
    if (hit.props.onClick) run(hit.props.onClick)
    for (const inst of instances) if (inst.id === hit.id) inst.api?.onClick?.(p)
  })
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (mode !== "play") return
    Object.assign(input.pointer, toContainer(e))
    emit("pointermove", input.pointer)
  })
  addEventListener("pointerup", () => {
    input.pointer.down = false
    if (mode === "play") emit("pointerup", input.pointer)
  })

  // ── 공개 API ────────────────────────────────────────────────────
  const engine = {
    VERSION,
    THREE,
    /** Free-form game variables. `reset()` clears them. */
    state: {},
    input,
    renderer,
    world,
    get mode() {
      return mode
    },
    get sceneId() {
      return sceneId
    },
    get scene() {
      return doc
    },
    get container() {
      return container
    },
    node: handle,
    nodes: () => [...nodes.keys()].map(handle),
    /** Add a node at runtime (not saved). `data` is a scene node object. */
    spawn(data) {
      if (!data?.id || nodes.has(data.id))
        throw new Error(`spawn: id "${data?.id}" 가 없거나 이미 있다`)
      const node = {
        parent: "root",
        type: "rect",
        props: {},
        ...structuredClone(data),
      }
      node.transform = {
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        anchor: "top-left",
        z: 0,
        ...node.transform,
      }
      nodes.set(node.id, node)
      doc.document.nodes.push(node)
      buildNode(node)
      return handle(node.id)
    },
    despawn(id) {
      const mesh = meshes.get(id)
      if (mesh) disposeMesh(mesh)
      meshes.delete(id)
      nodes.delete(id)
      handles.delete(id)
      instances = instances.filter((inst) => {
        if (inst.id !== id) return true
        inst.api?.dispose?.()
        return false
      })
      if (doc)
        doc.document.nodes = doc.document.nodes.filter((n) => n.id !== id)
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    run,
    say,
    goto,
    /** Animate numeric fields of a node handle (x, y, z) or of its props
     *  (opacity, rotation, scale). Returns a promise resolved at the end. */
    tween(
      target,
      to,
      { duration = 0.4, easing = "inOut", loop = false, yoyo = false } = {}
    ) {
      const h = typeof target === "string" ? handle(target) : target
      if (!h) return Promise.resolve()
      const from = {}
      for (const key of Object.keys(to))
        from[key] =
          key in h.data.transform
            ? h.data.transform[key]
            : (h.props[key] ?? (key === "opacity" || key === "scale" ? 1 : 0))
      return new Promise((resolve) => {
        tweens.push({
          h,
          from,
          to,
          duration: Math.max(0.001, duration),
          easing: ease[easing] || ease.inOut,
          loop,
          yoyo,
          t: 0,
          dir: 1,
          resolve,
        })
      })
    },
    /** Back to the document as loaded: state cleared, scripts restarted. */
    reset() {
      if (source) applyScene(source)
    },
  }

  function stepTweens(dt) {
    for (const tw of [...tweens]) {
      tw.t += (dt / tw.duration) * tw.dir
      let done = false
      if (tw.t >= 1) {
        if (tw.yoyo) {
          tw.t = 1
          tw.dir = -1
        } else if (tw.loop) tw.t = 0
        else {
          tw.t = 1
          done = true
        }
      } else if (tw.t <= 0 && tw.dir < 0) {
        tw.t = 0
        tw.dir = 1
        if (!tw.loop) done = true
      }
      const k = tw.easing(tw.t)
      const node = tw.h.data
      let rebuild = false
      for (const key of Object.keys(tw.to)) {
        const v = tw.from[key] + (tw.to[key] - tw.from[key]) * k
        if (key in node.transform) node.transform[key] = v
        else {
          node.props[key] = v
          if (key === "opacity") {
            const mesh = meshes.get(node.id)
            if (mesh) mesh.material.opacity = v
          } else if (key !== "rotation" && key !== "scale") rebuild = true
        }
      }
      if (rebuild) buildNode(node)
      else sync(node.id)
      if (done) {
        tweens = tweens.filter((x) => x !== tw)
        tw.resolve()
      }
    }
  }

  // ── 편집기 연결 ─────────────────────────────────────────────────
  function setMode(next) {
    const value = next === "edit" ? "edit" : "play"
    if (value === mode) return
    mode = value
    pressed.clear()
    if (source) applyScene(source)
    emit("mode", mode)
    reportState()
  }

  addEventListener("message", (e) => {
    const m = e.data
    if (!m || typeof m !== "object") return
    if (m.type === "codeg:scene" && m.scene?.document) applyScene(m.scene)
    else if (m.type === "codeg:mode") setMode(m.mode)
    else if (m.type === "codeg:reset") engine.reset()
    else if (m.type === "codeg:reload") location.reload()
  })

  // ── 시작 ────────────────────────────────────────────────────────
  try {
    const url = new URL(`${sceneId}.studio.json`, contentBase)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${url.pathname}`)
    applyScene(await res.json())
  } catch (err) {
    console.error("[scene] 장면을 읽지 못했다:", err)
    say(`장면을 읽지 못했다: ${err.message}`, 6000)
  }

  // 편집기가 고를 수 있게 등록된 스크립트·연산 이름과 내장 스크립트의 기본 설정을 알린다.
  if (embedded)
    parent.postMessage(
      {
        type: "codeg:ready",
        hot: true,
        modes: true,
        scene: sceneId,
        engine: "three-web",
        version: VERSION,
        scripts: Object.keys(scripts),
        ops: Object.keys(ops),
        builtins: builtinScriptDefaults,
      },
      "*"
    )

  setInterval(reportState, 400)

  // 콘솔과 테스트에서 들여다볼 수 있게 둔다: `codegEngine.node("hero").rect`
  window.codegEngine = engine

  let last = performance.now()
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (mode === "play") {
      for (const inst of [...instances]) {
        if (!inst.api?.update) continue
        try {
          inst.api.update(dt)
        } catch (err) {
          console.error(
            `[script ${inst.name}] update 오류 (node ${inst.id}) — 이 스크립트를 멈춘다:`,
            err
          )
          instances = instances.filter((x) => x !== inst)
        }
      }
      stepTweens(dt)
      emit("update", dt)
    }
    renderer.render(world, camera)
  })

  return engine
}

/** 내장 스크립트의 설정 키와 기본값. 편집기의 인스펙터가 이걸로 입력란을 만든다. */
export const builtinScriptDefaults = {
  float: { amplitude: 12, period: 2 },
  spin: { speed: 90 },
  pulse: { amount: 0.08, period: 1.2 },
  blink: { period: 1 },
  frames: { frames: [], fps: 8 },
  mover: { speed: 320, bounds: true },
}

// ── 내장 행동 ─────────────────────────────────────────────────────
// 노드의 `props.script` 에 이름(또는 { name, ...설정 })으로 붙인다. 편집기의
// 인스펙터가 이 목록을 보여 준다. 프로젝트의 scripts 가 같은 이름이면 그쪽이 이긴다.
export const builtinScripts = {
  /** 위아래로 둥실. { amplitude: 12, period: 2 } */
  float(node, _engine, { amplitude = 12, period = 2 } = {}) {
    const base = node.y
    let t = 0
    return {
      update(dt) {
        t += dt
        node.y = base + Math.sin((t / period) * Math.PI * 2) * amplitude
      },
    }
  },
  /** 회전. { speed: 90 } 도/초 */
  spin(node, _engine, { speed = 90 } = {}) {
    return {
      update(dt) {
        node.props.rotation = ((node.props.rotation || 0) + speed * dt) % 360
        node.moveBy(0, 0)
      },
    }
  },
  /** 커졌다 작아졌다. { amount: 0.08, period: 1.2 } */
  pulse(node, _engine, { amount = 0.08, period = 1.2 } = {}) {
    let t = 0
    return {
      update(dt) {
        t += dt
        node.props.scale = 1 + Math.sin((t / period) * Math.PI * 2) * amount
        node.moveBy(0, 0)
      },
    }
  },
  /** 깜박임. { period: 1 } */
  blink(node, _engine, { period = 1 } = {}) {
    let t = 0
    return {
      update(dt) {
        t += dt
        node.visible = t % period < period / 2
      },
    }
  },
  /** 프레임 애니메이션. { frames: ["hero_walk_1", "hero_walk_2"], fps: 8 } */
  frames(node, _engine, { frames = [], fps = 8 } = {}) {
    let t = 0
    let shown = -1
    return {
      update(dt) {
        if (frames.length === 0) return
        t += dt
        const i = Math.floor(t * fps) % frames.length
        if (i !== shown) {
          shown = i
          node.setAsset(frames[i])
        }
      },
    }
  },
  /** 방향키/WASD 로 움직인다. { speed: 320, bounds: true } */
  mover(node, engine, { speed = 320, bounds = true } = {}) {
    return {
      update(dt) {
        const dx = engine.input.axisX * speed * dt
        const dy = engine.input.axisY * speed * dt
        if (!dx && !dy) return
        if (dx) node.props.flipX = dx < 0
        node.moveBy(dx, dy)
        if (bounds) {
          const r = node.rect
          const { width, height } = engine.container
          node.moveBy(
            Math.min(0, width - (r.x + r.w)) + Math.max(0, -r.x),
            Math.min(0, height - (r.y + r.h)) + Math.max(0, -r.y)
          )
        }
      },
    }
  },
}
