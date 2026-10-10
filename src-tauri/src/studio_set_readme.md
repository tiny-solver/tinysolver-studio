# film/sets — 촬영장 문서

촬영장마다 `<set>.set.json` 하나. Tinysolver Studio 의 3D 촬영장 화면 · 에이전트(`studio_*_set` 도구) · Blender 렌더가 **같은 파일**을 읽는다. 화면에서 끌어 옮기면 이 파일이 바뀌고, 에이전트가 고치면 화면이 다시 읽는다.

```json
{
  "schema": 1,
  "id": "cafe",
  "name": "카페",
  "fps": 24,
  "duration": 15,
  "frame": { "width": 720, "height": 1280 },
  "stage": { "floor": { "size": 30, "color": "#d9d2c5" }, "background": "#ebe6de", "ambient": 0.6 },
  "props": [
    { "id": "room", "asset": "cafe-room", "position": [0, 0, 0], "rotation": [0, 0, 0], "height": 3 }
  ],
  "actors": [
    { "id": "mina", "asset": "mina-rig", "height": 1.6, "motion": "walk", "rotation": [0, 0, 0],
      "keys": [ { "t": 0, "position": [-2, 0, 0], "yaw": 90 }, { "t": 5, "position": [2, 0, 0], "yaw": 90 } ] }
  ],
  "lights": [
    { "id": "key", "type": "area", "position": [3, 4, 3], "target": [0, 1, 0], "power": 600, "size": 3, "color": "#ffffff" }
  ],
  "cameras": [
    { "id": "cam_a", "name": "정면", "lens": 35, "ease": "smooth",
      "keys": [ { "t": 0, "position": [0, 1.5, 6], "target": [0, 1, 0] },
                { "t": 5, "position": [1.5, 1.4, 3], "target": [0, 1.2, 0] } ] }
  ]
}
```

- 공간: 미터, **Y 가 위**, 오른손 좌표(glTF 와 같다). 정면은 +Z 쪽. `rotation` 은 XYZ 오일러 각(도).
- `asset`: `assets/manifest.json` 의 3D 모델(GLB) 재료 id. 모델은 발밑 가운데가 `position` 에 서고, `height` 를 주면 그 키(미터)로 맞춘다(`scale` 은 배율).
- 배우 `motion`: `still` · `walk`(리깅된 모델이 제자리 걸음 — 위치는 `keys` 가 옮긴다). 배우 `keys[]` 는 `{ t, position, yaw? }`.
- 카메라: `lens` 는 초점거리(mm, 36mm 센서 · 긴 변 기준). `keys[]` 는 `{ t, position, target, roll? }` — 하나 이상.
- 시간: 초(0 – `duration`). 키 사이는 `ease` 로 섞는다 — `smooth`(구간마다 u²(3−2u), 기본) · `linear`. 첫 키 전은 첫 키, 끝 키 뒤는 끝 키 그대로.
- 조명 `type`: `sun`(`power` 는 세기 1–5 정도) · `point` · `spot` · `area`(`power` 는 와트, `size` 미터). 3D 화면의 조명은 근사다 — 최종 밝기는 Blender 렌더가 정본이다.
- id 는 소품 · 배우 · 조명 · 카메라 통틀어 겹치지 않는다. 모르는 필드는 보존된다.

고치기: `studio_apply_scene_commands` 가 아니라 `studio_apply_set_commands` — 검증되고 원자적이다(하나라도 틀리면 아무것도 안 쓴다).

- `{ "type": "set.update", "name"?, "fps"?, "duration"?, "frame"?, "stage"? }`
- `{ "type": "add", "kind": "prop" | "actor" | "light" | "camera", "item": { … } }`
- `{ "type": "update", "id": "room", "patch": { "position": [0, 0, -2], "height": null } }` — `null` 은 필드를 지운다.
- `{ "type": "remove", "id": "rim" }`
- `{ "type": "key.set", "id": "cam_a", "key": { "t": 2, "position": [1, 1.5, 4] } }` — 그 시각의 키에 합친다(없으면 새 키).
- `{ "type": "key.remove", "id": "cam_a", "t": 2 }`

결과의 `issues` 는 파일은 맞지만 렌더를 망칠 것(없는 재료 · 뼈 없는 걷기 · 길이 밖의 키 · 카메라 없음)이다. 있으면 고친다.

렌더: `studio_render_set { set, camera, from?, to?, stills? }` — 사용자 PC 의 Blender 가 이 파일을 그대로 장면으로 만들어 그 카메라로 찍는다. 영상(mp4)과 스틸(PNG)이 `assets/generated/renders/` 재료로 등록된다.
