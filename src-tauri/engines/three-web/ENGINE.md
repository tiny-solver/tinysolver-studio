# codeg-engine (three-web) 0.3.0

Codeg Studio가 제공하는 2D 장면 런타임이다. **프로젝트 안에 엔진 코드는 없다.** 미리보기 서버가 `__codeg/` 아래로 서빙하고, 빌드 버튼이 같은 경로에 넣어 준다. 그래서 Studio가 새 버전을 내면 모든 프로젝트가 같이 좋아진다. 엔진을 복사해 와서 고치지 않는다. 이 게임만의 규칙은 `src/`에 쓴다.

```
outputs/game/
├── index.html            importmap: three, codeg-engine → ../../__codeg/…
├── content/<scene>.studio.json   장면 (편집기·엔진·에이전트가 같이 쓰는 파일)
└── src/
    ├── main.js           start({ scripts, ops, setup })
    └── scripts/index.js  이 게임의 스크립트
```

런타임 소스를 읽고 싶으면 미리보기 주소의 `__codeg/engine/three-web/runtime.js`를 연다.

## 시작

```js
import { start } from "codeg-engine"
import { scripts } from "./scripts/index.js"

start({
  scripts,                       // 노드에 붙는 행동
  ops: { shake(step, engine) {} }, // logic.actions 에서 쓸 연산 추가
  setup(engine) {},              // 게임이 (다시) 시작할 때마다
})
```

## 장면에서 엔진으로 가는 것

| 장면 필드 | 뜻 |
| --- | --- |
| `props.script` | 붙일 스크립트. `"float"`, `{ "name": "float", "amplitude": 20 }`, 또는 그 배열 |
| `props.interactive` + `props.onClick` | 클릭하면 `logic.actions[onClick]` 실행 |
| `props.visible` `opacity` `rotation`(도) `scale` `flipX` `tint` | 그리기 |
| `props.asset` / `placeholder` | sprite 의 에셋 id / 에셋이 없을 때 색 |
| `props.text` `size` `color` `align` `weight` `font` | text |
| `logic.actions.<name>` | `[{ "op": …, "if"?: { "key": "coins", "atLeast": 3 } }]` |

내장 op: `toggle {id}` · `setVisible {id,value}` · `say {text}` · `swapAsset {id,asset}` · `setText {id,text}` · `move {id,x,y,by?,duration?}` · `set {key,value}` · `add {key,value}` · `goto {scene}` · `run {action}`.
`if` 조건: `equals`, `atLeast`, `not`, 또는 키만 주면 truthy.

내장 스크립트: `float {amplitude,period}` · `spin {speed}` · `pulse {amount,period}` · `blink {period}` · `frames {frames:[assetId…],fps}` · `mover {speed,bounds}`(방향키/WASD).

## 스크립트

```js
// src/scripts/index.js
export const scripts = {
  // (node, engine, config) => { update?, onClick?, dispose? }
  patrol(node, engine, { from = 100, to = 900, speed = 200 } = {}) {
    let dir = 1
    return {
      update(dt) {
        node.x += dir * speed * dt
        if (node.x > to) dir = -1
        if (node.x < from) dir = 1
        if (node.overlaps("hero")) engine.run("act_caught")
      },
    }
  },
}
```

장면 쪽: `"props": { "script": { "name": "patrol", "to": 700 } }`. 편집기의 인스펙터에서도 붙인다.

- 게임은 플레이 모드 진입, `engine.reset()`, 장면 갱신 때마다 **처음부터 다시 시작한다**: `engine.state`와 `engine.on` 리스너가 비워지고 `setup`과 스크립트가 다시 돈다. 그래서 변수 초기값과 리스너 등록은 `setup` 안에 둔다.
- 스크립트는 **플레이 모드에서만** 돈다. 편집 모드에서는 장면이 문서 그대로 그려져서 편집기의 선택 상자와 어긋나지 않는다.
- `update` 에서 예외가 나면 그 스크립트만 멈추고 오류가 편집기에 뜬다. 오류를 삼키지 않는다.

## engine

| | |
| --- | --- |
| `engine.node(id)` | 노드 핸들. 없으면 `null` |
| `engine.nodes()` | 모든 핸들 |
| `engine.spawn(node)` / `despawn(id)` | 실행 중 추가·제거 (저장되지 않는다) |
| `engine.state` | 게임 변수. `set`/`add` op 와 같은 곳 |
| `engine.run(action)` `say(text)` `goto(sceneId)` `reset()` | |
| `engine.on(event, fn)` | `update(dt)` `pointerdown({x,y,node})` `pointermove` `pointerup` `keydown` `keyup` `scene` `state` `mode`. 해제 함수를 돌려준다 |
| `engine.input` | `down("ArrowLeft" \| "KeyA")`, `axisX`, `axisY`, `pointer {x,y,down}` |
| `engine.tween(idOrHandle, { x, y, opacity, rotation, scale }, { duration, easing, loop, yoyo })` | Promise |
| `engine.container` `engine.scene` `engine.sceneId` `engine.mode` | |
| `engine.THREE` `engine.world` `engine.renderer` | 엔진에 없는 것을 직접 그릴 때 |

노드 핸들: `id` `data` `props` `mesh` · `x` `y` `z` `visible`(쓰기 가능) · `w` `h` `rect` · `moveTo(x,y)` `moveBy(dx,dy)` · `set(propsPatch)` `setAsset(id)` `setText(text)` · `overlaps(other)` · `tween(to, opts)`.

좌표는 컨테이너 픽셀, 원점 좌상단, y 아래. 자식 노드는 부모의 좌상단 기준이다.

## 편집기 계약

엔진이 지킨다. 직접 엔진을 쓰는 경우에만 신경 쓴다.

1. `?scene=<id>`, `?codeg=edit`.
2. `parent.postMessage({ type: "codeg:ready", hot: true, modes: true, scripts, ops, builtins })`. `scripts`·`ops`는 등록된 이름 목록이고 편집기의 선택 목록이 된다.
3. 받는 메시지: `codeg:scene { scene }`, `codeg:mode { mode }`, `codeg:reset`, `codeg:reload`.
4. 플레이 중 `engine.state`가 바뀌면 `codeg:state { mode, state }`를 보낸다. 편집기가 게임 변수를 보여 준다.
