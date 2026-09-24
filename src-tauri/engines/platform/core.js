// codeg-platform · 공통부 v1
//
// 게임은 `import { platform } from "codeg-platform"` 하나만 부른다. importmap 이
// `codeg-platform` 을 `__codeg/platform/current.js` 에 잇고, 그 파일이 빌드 대상의
// 어댑터다 — 미리보기는 studio, 빌드는 web(나중에 afterplay · tauri · capacitor).
// 이 파일은 대상과 무관한 공통부: 표면 · 입력 검사 · 없는 능력의 기본 동작.
//
// 표면은 afterplay SDK v2 의 부분집합이다. afterplay 어댑터가 1:1 로 얇게 감쌀 수 있게
// 이름과 인자 모양을 그대로 따른다. 설명은 ENGINE.md 의 "플랫폼" 절.
//
// 없는 능력은 던지지 않는다 — `has()` 가 false 이고, 부르면 "안 된 것"을 돌려준다
// (저장 없음 → null, 순위 → [], 광고 → { shown: false }). 게임이 has() 를 깜박해도
// 어디서든 돈다가 먼저다.

export const API_VERSION = 1

/** has() 가 아는 능력 이름. v2 의 같이 놀기(challenge · match · room)는 이름만 먼저 둔다. */
export const CAPABILITIES = [
  "save",
  "player",
  "login",
  "leaderboard",
  "share",
  "ads",
  "achievement",
  "challenge",
  "match",
  "room",
]

/** afterplay SDK v2 와 같은 한도 — 여기서 넘으면 afterplay 에서도 넘는다. */
export const SLOTS = 3
export const SLOT_BYTES = 64 * 1024

function slotOf(options) {
  const slot = options?.slot ?? 0
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS)
    throw new RangeError(
      `[codeg-platform] slot 은 0~${SLOTS - 1} 이다: ${slot}`
    )
  return slot
}

function boardOf(options) {
  const board = options?.board ?? "main"
  if (typeof board !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(board))
    throw new RangeError(`[codeg-platform] board 이름이 이상하다: ${board}`)
  return board
}

/**
 * 키-값 저장소. 브라우저 저장소를 못 쓰면(sandbox · 사생활 모드) 메모리로 내려간다 —
 * 게임은 안 죽고 저장만 그 탭 안에서 끝난다. `persistent` 가 그 차이를 알려 준다.
 */
export function browserStorage(scope) {
  const memory = new Map()
  let store = null
  try {
    store = window.localStorage
    const probe = `${scope}:__probe`
    store.setItem(probe, "1")
    store.removeItem(probe)
  } catch {
    store = null
  }
  return {
    persistent: store !== null,
    get(key) {
      const k = `${scope}:${key}`
      if (store) {
        try {
          return store.getItem(k)
        } catch {}
      }
      return memory.has(k) ? memory.get(k) : null
    },
    set(key, value) {
      const k = `${scope}:${key}`
      if (store) {
        try {
          store.setItem(k, value)
          return
        } catch {}
      }
      memory.set(k, value)
    },
  }
}

/**
 * 어댑터가 부른다. `impl`:
 *   caps        능력 이름 목록
 *   storage     { get(key), set(key, value) } — save/load 가 쓴다
 *   player()    Player | null        login() → Player | null
 *   submitScore(score, board) · leaderboard({ board, around, limit })
 *   share(text, { image }) → boolean
 *   adsBreak({ type, name }, emit) → { shown, rewarded }
 *   gameplay(on: boolean)
 *   lifecycle(emit)  pause/resume 을 언제 낼지. 기본은 탭 숨김(visibilitychange).
 */
export function makePlatform(target, impl = {}) {
  const caps = new Set(impl.caps || [])
  const listeners = { pause: new Set(), resume: new Set() }
  const warned = new Set()
  let paused = false

  function emit(event) {
    if (event === "pause" || event === "resume") {
      const next = event === "pause"
      if (next === paused) return
      paused = next
    }
    for (const fn of [...(listeners[event] || [])]) {
      try {
        fn()
      } catch (err) {
        console.error(`[codeg-platform] '${event}' 처리 중 오류:`, err)
      }
    }
  }

  function missing(cap, fallback) {
    if (!warned.has(cap)) {
      warned.add(cap)
      console.warn(
        `[codeg-platform] '${target}' 에는 ${cap} 이(가) 없다 — platform.has('${cap}') 로 확인하고 UI 를 숨긴다`
      )
    }
    return fallback
  }

  ;(
    impl.lifecycle ||
    ((send) => {
      document.addEventListener("visibilitychange", () =>
        send(document.hidden ? "pause" : "resume")
      )
    })
  )(emit)

  const platform = {
    target,
    version: API_VERSION,

    /** 이 대상에서 되는 능력인가. 모르는 이름은 false. */
    has(cap) {
      return caps.has(cap)
    },

    /** 시작 정보. 게임 시작 전에 한 번 기다린다(afterplay 는 부모와 인사가 끝나야 한다). */
    async ready() {
      return {
        target,
        player: platform.player(),
        launch: { from: target },
        locale: navigator.language || "ko",
      }
    },

    // ── 신원 ──────────────────────────────────────────────────────
    /** Player = { id(게임별 가명), name, avatar, level } | null(익명) */
    player() {
      return caps.has("player") && impl.player ? impl.player() : null
    },
    async login() {
      if (!caps.has("login") || !impl.login) return missing("login", null)
      return impl.login()
    },

    // ── 수명 ──────────────────────────────────────────────────────
    gameplayStart() {
      impl.gameplay?.(true)
    },
    gameplayStop() {
      impl.gameplay?.(false)
    },
    /** 'pause' | 'resume' — 탭 숨김 · 광고 · 앱 백그라운드. 게임은 소리와 시간을 멈춘다. 끄는 함수를 돌려준다. */
    on(event, fn) {
      if (!listeners[event])
        throw new RangeError(`[codeg-platform] 모르는 이벤트: ${event}`)
      listeners[event].add(fn)
      return () => listeners[event].delete(fn)
    },
    get paused() {
      return paused
    },

    // ── 기록 ──────────────────────────────────────────────────────
    /** JSON 으로 바꿀 수 있는 값 하나. 슬롯 3개(0~2) · 각 64KB. */
    async save(data, options) {
      const slot = slotOf(options)
      const text = JSON.stringify(data ?? null)
      const bytes = new TextEncoder().encode(text).length
      if (bytes > SLOT_BYTES)
        throw new RangeError(
          `[codeg-platform] 저장이 ${bytes}B — 슬롯 하나는 ${SLOT_BYTES}B 까지다`
        )
      if (!caps.has("save") || !impl.storage) return missing("save", undefined)
      impl.storage.set(`save:${slot}`, text)
    },
    /** 저장한 값, 없으면 null. */
    async load(options) {
      const slot = slotOf(options)
      if (!caps.has("save") || !impl.storage) return missing("save", null)
      const text = impl.storage.get(`save:${slot}`)
      if (text == null) return null
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    },
    /** → { ok, best? } . 순위가 없는 대상은 { ok: false }. */
    async submitScore(score, options) {
      const board = boardOf(options)
      if (typeof score !== "number" || !Number.isFinite(score))
        throw new TypeError(`[codeg-platform] 점수는 숫자다: ${score}`)
      if (!caps.has("leaderboard") || !impl.submitScore)
        return missing("leaderboard", { ok: false })
      return impl.submitScore(score, board)
    },
    /** → [{ rank, name, score, me }] . 순위가 없는 대상은 []. */
    async leaderboard(options = {}) {
      const board = boardOf(options)
      const around = options.around === "me" ? "me" : "top"
      const limit = Math.max(1, Math.min(100, options.limit ?? 10))
      if (!caps.has("leaderboard") || !impl.leaderboard)
        return missing("leaderboard", [])
      return impl.leaderboard({ board, around, limit })
    },

    // ── 소셜 ──────────────────────────────────────────────────────
    /** → 공유했으면 true. afterplay 는 사람이 확인하고 올린다. */
    async share(text, options = {}) {
      if (!caps.has("share") || !impl.share) return missing("share", false)
      return impl.share(String(text ?? ""), options)
    },

    // ── 광고 — 부모(플랫폼)가 그린다 ───────────────────────────────
    ads: {
      /** type: 'start' | 'next' | 'pause' | 'reward' → { shown, rewarded } */
      async break(options = {}) {
        if (!caps.has("ads") || !impl.adsBreak)
          return missing("ads", { shown: false, rewarded: false })
        return impl.adsBreak(
          { type: options.type || "next", name: options.name || "" },
          emit
        )
      },
    },
  }
  return platform
}
