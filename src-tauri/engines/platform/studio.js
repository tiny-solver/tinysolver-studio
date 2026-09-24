// codeg-platform · studio 어댑터 — Tinysolver Studio 미리보기의 가짜판
//
// 미리보기 서버가 `__codeg/platform/current.js` 로 이 파일을 준다. 모든 능력을
// 가짜로 켜서, 게임이 afterplay 에서 쓸 UI(로그인 · 순위 · 공유 · 광고)를
// 미리보기에서 먼저 확인하게 한다. 저장과 순위는 이 브라우저(Studio 웹뷰)에 남아
// 새로고침 · Studio 재시작 뒤에도 이어진다. 프로젝트마다 따로다.
import { makePlatform, browserStorage } from "./core.js"

const scope = `codeg-studio:${window.__codegPreview?.scope || location.pathname.split("/").slice(0, 4).join("/")}`
const storage = browserStorage(scope)

const me = { id: "studio-player", name: "나 (미리보기)", avatar: null, level: 1 }
let signedIn = true

// 순위표가 비어 보이지 않게 가짜 경쟁자 셋.
const RIVALS = [
  { name: "가짜 친구 A", score: 300 },
  { name: "가짜 친구 B", score: 120 },
  { name: "가짜 친구 C", score: 40 },
]

function best(board) {
  const raw = storage.get(`score:${board}`)
  return raw === null ? null : Number(raw)
}

export const platform = makePlatform("studio", {
  caps: ["save", "player", "login", "leaderboard", "share", "ads"],
  storage,
  player: () => (signedIn ? { ...me } : null),
  async login() {
    signedIn = true
    return { ...me }
  },
  gameplay(on) {
    console.info(`[codeg-platform] gameplay${on ? "Start" : "Stop"}`)
  },
  async submitScore(score, board) {
    const prev = best(board)
    const top = prev === null ? score : Math.max(prev, score)
    storage.set(`score:${board}`, String(top))
    return { ok: true, best: top }
  },
  async leaderboard({ board, limit }) {
    const mine = best(board)
    const rows = [...RIVALS]
    if (mine !== null) rows.push({ name: me.name, score: mine, me: true })
    rows.sort((a, b) => b.score - a.score)
    return rows.slice(0, limit).map((row, i) => ({ rank: i + 1, me: false, ...row }))
  },
  async share(text) {
    console.info("[codeg-platform] share (미리보기 — 실제로 올리지 않는다):", text)
    return true
  },
  // 진짜 광고처럼 pause → 잠깐 → resume 을 낸다. 게임의 멈춤 처리를 여기서 본다.
  async adsBreak({ type, name }, emit) {
    console.info(`[codeg-platform] ads.break ${type} ${name} (미리보기 — 가짜 광고)`)
    emit("pause")
    await new Promise((r) => setTimeout(r, 400))
    emit("resume")
    return { shown: true, rewarded: type === "reward" }
  },
})

export default platform
