// codeg-platform · web 어댑터 — 독립 웹(itch.io · 자체 도메인 · Studio 의 /play 링크)
//
// 빌드가 이 파일을 `__codeg/platform/current.js` 로 쓴다. 서버가 없으니 계정 ·
// 순위 · 광고는 없다(has() 가 false). 저장은 이 브라우저의 localStorage — 같은
// 호스트에 게임이 여럿 있어도 섞이지 않게 페이지 폴더 경로로 나눈다. 저장소를
// 못 쓰는 곳(sandbox iframe 등)에서는 메모리로 내려가 게임은 계속 돈다.
import { makePlatform, browserStorage } from "./core.js"

const dir = location.pathname.replace(/[^/]*$/, "")
const storage = browserStorage(`codeg:${dir}`)

const canShare =
  typeof navigator !== "undefined" &&
  (typeof navigator.share === "function" || !!navigator.clipboard)

export const platform = makePlatform("web", {
  caps: canShare ? ["save", "share"] : ["save"],
  storage,
  async share(text) {
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ text })
        return true
      }
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  },
})

export default platform
