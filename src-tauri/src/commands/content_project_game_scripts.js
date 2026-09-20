// 이 게임의 스크립트. 장면 노드의 `props.script` 에 이름으로 붙인다:
//   "script": "follow"  또는  "script": { "name": "follow", "speed": 400 }
// Tinysolver Studio 의 인스펙터에서도 붙일 수 있다. 내장 스크립트(float, spin, pulse,
// blink, frames, mover)는 등록하지 않아도 된다. API 는 ../../ENGINE.md.
//
// (node, engine, config) => { update?(dt), onClick?(), dispose?() }
// 플레이 모드에서만 돈다. 편집 모드에서는 장면이 문서 그대로 그려진다.
export const scripts = {
  // 포인터를 따라간다.
  follow(node, engine, { speed = 600 } = {}) {
    return {
      update(dt) {
        if (!engine.input.pointer.down) return
        const dx = engine.input.pointer.x - node.x
        const dy = engine.input.pointer.y - node.y
        const dist = Math.hypot(dx, dy)
        if (dist < 4) return
        const step = Math.min(dist, speed * dt)
        node.moveBy((dx / dist) * step, (dy / dist) * step)
      },
    }
  },
}
