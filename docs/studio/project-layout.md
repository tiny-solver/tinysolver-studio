# 콘텐츠 프로젝트 폴더 규칙

세계관·캐릭터·스토리를 한 번 만들고, 그로부터 게임·웹툰·인스타툰·소설·영상을 만드는 폴더 계약이다. 정본은 `src-tauri/src/commands/content_project.rs`의 스캐폴드이며, 이 문서는 그 결과를 설명한다. 스캐폴드가 바뀌면 이 문서도 같은 변경에서 고친다.

## 진입점

| 위치 | 동작 |
| --- | --- |
| 시작 화면 → 창작 스튜디오 탭 → 새 콘텐츠 프로젝트 | Project Boot 창의 콘텐츠 탭을 연다 |
| 시작 화면 → 창작 스튜디오 탭 → 프로젝트 열기 | 폴더 열기 대화상자. `codeg-project.json`이 있으면 탭 위에 프로젝트 이름과 결과물이 표시된다 |
| Project Boot → 콘텐츠 탭 | 이름·위치·템플릿·결과물을 고르고 생성, 곧바로 작업공간에 연다 |
| 사이드바 `+` → 새 프로젝트 / 상태바 빠른 작업 → 새 프로젝트 | 같은 Project Boot 창 |
| 창작 스튜디오 탭 → Studio 열기 / 상태바 빠른 작업 → 콘텐츠 스튜디오 | 활성 폴더를 대상으로 Studio가 대화 옆 파일 창(퓨전 모드)에 열린다. 폴더가 없으면 `/studio` 전체 페이지(브라우저 초안) |

백엔드 명령: `list_content_templates`, `create_content_project`, `read_content_project`, `list_content_scenes`, `build_content_project`, `list_content_builds`, `get_content_preview`. 데스크톱(Tauri)과 서버(Axum) 모두 같은 `_core` 없는 단일 구현을 쓴다.

## 폴더

```
<project>/
├── codeg-project.json      매니페스트 (아래)
├── AGENTS.md               폴더 규칙. 모든 에이전트 CLI가 읽는다
├── CLAUDE.md               AGENTS.md와 같은 내용 (Claude Code용)
├── README.md
├── .gitignore              build/ 제외
├── bible/                  단일 정본
│   ├── world.md            세계관·규칙·장소·용어집
│   ├── characters/         캐릭터당 <slug>.md, _template.md 복사
│   └── story/              synopsis.md, episodes/
├── assets/                 원본 에셋 + manifest.json (game-asset-contract 규칙)
│   ├── characters/<slug>/
│   ├── backgrounds/
│   └── ui/
├── outputs/                결과물별 소스 (선택한 것만 생성)
│   ├── game/               GDD.md, content/<scene>.studio.json, src/main.js, index.html
│   ├── webtoon/episodes/   NN-<slug>/script.md, cuts.md
│   ├── instatoon/posts/    NN-<slug>/post.md
│   ├── novel/chapters/     NN-<slug>.md
│   └── video/storyboards/  NN-<slug>.md, _template.md
└── build/                  생성 산출물, git 제외
```

레이어 규칙은 생성된 `AGENTS.md`에 있다. 요지:

- 이름·용어는 bible 표기를 따른다. 새 이름은 bible에 먼저.
- 결과물 폴더끼리 import하지 않는다. 공유할 것은 bible이나 assets로.
- 에셋 파일명은 `<대상>_<상태>_<WxH>.png`, 실제 크기와 일치.
- 생성물은 build/에만. 원본을 덮어쓰지 않는다.
- 회차·챕터·포스트는 `NN-` 접두사로 순서 고정.

## 매니페스트 `codeg-project.json`

```json
{
  "schema": 1,
  "name": "my-story",
  "created_at": "2026-09-19T09:00:00Z",
  "template": "web-three",
  "outputs": ["game", "video"],
  "engine": {
    "id": "three-web",
    "version": "0.2.0",
    "entry": "outputs/game/index.html",
    "start": "npx serve . -l 4173  # http://localhost:4173/outputs/game/",
    "build": null
  },
  "paths": { "bible": "bible", "assets": "assets", "outputs": "outputs", "build": "build" },
  "agents": { "writing": null, "art": null, "code": null, "video": null }
}
```

- `schema`: 읽는 쪽은 자기보다 큰 값을 거부한다.
- `outputs`: 정렬·중복 제거된 kebab-case. 없는 결과물 폴더는 만들지 않는다.
- `engine`: game 결과물이 있고 템플릿이 엔진을 제공할 때만 존재. `build`는 패키징 전 실행할 셸 명령(선택). `start`는 프로젝트 루트에서 서빙해야 에셋 상대 경로가 맞는다.
- `paths`: 레이어 위치 선언. 도구는 하드코딩 대신 이 값을 읽는다.
- `agents`: 역할별 선호 에이전트. `null`이면 사용자가 고른 에이전트. 매니페스트에 두는 이유는 프로젝트와 함께 이동하기 위해서다.

## 템플릿

| id | 엔진 | 기본 결과물 |
| --- | --- | --- |
| `story` | 없음 | webtoon, novel |
| `web-three` | `three-web` 0.2.0 (importmap으로 Three.js 로드, 빌드 없음, 장면 러너 + 편집기 계약) | game, video |

## 장면 문서: 엔진과 편집기가 같은 파일

게임의 장면은 `<outputs>/game/content/<scene>.studio.json`이다. 엔진(`src/main.js`)이 이 파일을 읽어 그리고, Codeg Studio 편집기가 같은 파일을 편집하며, 에이전트도 같은 파일을 고친다. 별도 렌더러나 별도 포맷은 없다.

```json
{
  "schema": 1,
  "id": "main",
  "name": "첫 장면",
  "document": {
    "container": { "width": 1080, "height": 1920 },
    "assets": [{ "id": "hero_idle", "file": "characters/hero/hero_idle_120x180.png", "width": 120, "height": 180, "missing": true }],
    "nodes": [
      { "id": "hero", "parent": "root", "type": "sprite",
        "transform": { "x": 540, "y": 1500, "w": 120, "h": 180, "anchor": "bottom-center", "z": 20 },
        "props": { "asset": "hero_idle", "interactive": true, "onClick": "act_hero", "placeholder": "#e8d5a3" } }
    ]
  },
  "logic": { "actions": { "act_hero": [{ "op": "say", "text": "안녕" }] } }
}
```

- 편집기가 검증·편집하는 핵심: `container`, `assets[].{id,file,width,height,missing}`, `nodes[].{id,parent,type,transform}`, `props.visible/asset/text/size/color/interactive/onClick`. 그 밖의 필드(`logic`, `grid`, 엔진 전용 props)는 그대로 보존한다.
- 좌표는 컨테이너 픽셀, 원점 좌상단, y 아래. `anchor`는 `top-left`·`center`·`bottom-center`. `parent`가 다른 노드 id면 그 노드 좌상단 기준 상대 좌표, 없는 id(`root`, `ui`)는 화면 원점.
- `assets[].file`은 `<assets>/` 기준 상대 경로. `..`나 절대 경로는 거부한다.
- 첫 프로토타입의 `codeg-studio-project` 파일은 읽을 때 변환되고 다음 저장에서 현재 스키마로 바뀐다. 그 이미지는 `content/blobs/`에 있었으므로 `missing`으로 표시된다.

## 엔진 계약 (`three-web` 0.2.0)

편집기는 게임을 **iframe으로 그대로** 띄우고 그 위에 선택·드래그 오버레이를 얹는다. 그러려면 엔진이 두 가지를 지켜야 한다. 스캐폴드된 러너는 지키고, 에이전트가 엔진을 새로 쓰더라도 유지하도록 `AGENTS.md`에 적혀 있다.

1. `?scene=<id>`로 장면을 고른다(기본 `main`).
2. 로드되면 `parent.postMessage({ type: "codeg:ready", hot, scene })`를 보낸다. `hot: true`면 `{ type: "codeg:scene", scene }` 메시지로 받은 문서를 즉시 다시 그린다. 편집기는 hot 엔진에는 편집마다 문서를 보내고, `hot: false` 엔진은 저장 뒤 iframe을 다시 불러온다.

러너가 이해하는 `logic.actions` 연산: `toggle {id}`, `setVisible {id,value}`, `say {text}`, `swapAsset {id,asset}`, `goto {scene}`.

## 미리보기 서빙

프로젝트 폴더를 HTTP로 서빙하는 것은 백엔드다(`src-tauri/src/content_preview.rs`). `get_content_preview(root)`가 폴더를 등록하고 추측할 수 없는 id를 돌려주며, iframe은 `/api/content-preview/<id>/outputs/game/index.html`을 연다. 이 라우트는 Bearer 없이 열리는 공개 라우터에 있고 id가 자격이다(iframe 탐색은 헤더를 못 싣는다). 데스크톱은 내장 웹 서비스가 꺼져 있어도 되도록 첫 호출에 `127.0.0.1:<임시 포트>` 루프백 리스너를 띄워 같은 핸들러를 서빙한다. 요청은 등록된 루트 안으로 제한되고(정규화, 심링크 탈출 거부), 캐시는 `no-store`다.

## 에이전트 연결

- **도구**: 세션의 작업 폴더가 콘텐츠 프로젝트(`codeg-project.json` 또는 `outputs/game/content/`가 있음)면 codeg-mcp 동반 프로세스가 `studio` 도구 그룹을 노출한다. 설정 토글이 아니라 폴더로 정해진다.

  | 도구 | 동작 |
  | --- | --- |
  | `studio_list_scenes` | 프로젝트 이름·엔진·장면 id 목록 |
  | `studio_read_scene` | 장면 파일 JSON |
  | `studio_apply_scene_commands` | 편집기와 같은 명령 배치를 검증해 원자적으로 파일에 쓴다. 하나라도 틀리면 아무것도 쓰지 않는다 |
  | `studio_build` | `build_content_project` |

  검증기는 `src-tauri/src/studio_scene.rs`이고 `src/lib/studio/document.ts`와 규칙이 같아야 한다(한쪽을 고치면 다른 쪽도). 도구는 파일만 쓴다. 편집기·미리보기는 아래 변경 감시로 알아챈다. `project` 인자를 생략하면 세션의 작업 폴더가 대상이다.
- **컨텍스트**: 편집기의 "대화로 보내기"는 옆 대화 입력창에 장면 파일 배지와 `[Codeg Studio] Scene … Selected node … Runtime errors …` 텍스트를 넣는다(`src/lib/studio/agent-context.ts`). 자동 전송은 없다.
- **오류**: 미리보기 서버가 HTML `<head>` 맨 앞에 보고 스크립트를 주입해 `{ type: "codeg:error", kind, message }`를 parent로 올린다. 엔진의 협조가 필요 없다. 패키징된 빌드는 파일 복사라서 포함되지 않는다.

## 변경 감시

편집기는 파일 탭과 같은 작업공간 스트림(`getWorkspaceStateStore(root).acquire("paths")`)을 구독한다. 현재 장면 파일이 바뀌면 etag를 비교해 편집 중이 아니면 다시 읽고, 편집 중이면 배너를 띄운다(자기 저장의 에코는 etag가 같아 무시된다). `outputs/game/` 또는 `assets/` 아래 다른 파일이 바뀌면 iframe을 다시 불러온다. 장면 파일이 생기거나 지워지면 장면 목록을 갱신한다.

## 빌드

편집기의 빌드 버튼은 `build_content_project(root)`를 부른다.

1. 매니페스트 `engine.build`가 있으면 프로젝트 루트에서 셸로 실행한다(종료 코드 0이어야 한다). `three-web`은 빌드 단계가 없어 `null`이다.
2. `<build>/game/v<N>-<yyyymmdd-HHMM>/` 아래에 `<outputs>/game/`과 `<assets>/`를 **같은 상대 구조로** 복사한다(dot 파일·`node_modules`·심링크 제외). 그래서 엔진의 `../../../assets/` 상대 경로가 그대로 동작한다. 루트에 `index.html`(진입점으로 리다이렉트)과 `build-info.json`을 쓴다.
3. 같은 이름의 `.zip`을 옆에 만든다. 실패한 빌드는 디렉터리를 남기지 않는다.

`list_content_builds(root)`가 `build-info.json`을 읽어 최신순으로 돌려주고, 편집기 사이드바에 보인다. 데스크톱에서는 zip을 Finder에서 보여 준다.

## 아직 없는 것

- 매니페스트를 읽어 사이드바 폴더를 구분하지 않는다. `FolderDetail.kind` 확장은 DB 마이그레이션을 수반하므로 보류.
- 결과물 추가/제거 UI가 없다. 매니페스트와 폴더를 직접 고친다.
- `agents` 역할을 실제 에이전트 선택에 반영하지 않는다.
- 편집기에서 이미지를 업로드해 `assets/`에 넣는 기능이 없다. 에셋은 에이전트나 사용자가 `assets/`에 두고 장면 파일에 선언한다.
- 배포는 zip을 사용자가 정적 호스트에 올리는 것까지다. 호스팅 연동은 없다.
