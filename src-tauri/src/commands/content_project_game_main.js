// 이 게임의 진입점.
//
// 엔진은 Tinysolver Studio 가 제공한다(`codeg-engine`, 설명은 ../ENGINE.md). 이 폴더에는
// 엔진 코드가 없고 복사해 오지도 않는다. 여기에는 이 게임만의 규칙을 쓴다:
//   - scripts: 노드에 붙는 행동 (./scripts/index.js)
//   - ops: logic.actions 에서 쓸 연산
//   - setup: 첫 장면이 뜬 뒤 한 번
import { start } from "codeg-engine"
import { scripts } from "./scripts/index.js"

start({
  scripts,
  ops: {
    // 예: { "op": "shake", "id": "hero" }
    shake({ id }, engine) {
      const node = engine.node(id)
      if (!node) return
      const x = node.x
      node
        .tween({ x: x + 12 }, { duration: 0.06, yoyo: true })
        .then(() => (node.x = x))
    },
  },
  setup(engine) {
    // 게임 변수는 engine.state 에 둔다. `set`/`add` op 와 같은 곳이다.
    engine.state.taps = 0
    engine.on("pointerdown", () => (engine.state.taps += 1))
  },
})
