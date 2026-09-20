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

백엔드 명령: `list_content_templates`, `create_content_project`, `read_content_project`, `list_content_scenes`, `build_content_project`, `list_content_builds`, `publish_content_build`, `unpublish_content_game`, `get_content_preview`. 데스크톱(Tauri)과 서버(Axum) 모두 같은 `_core` 없는 단일 구현을 쓴다.

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
│   ├── game/               GDD.md, ENGINE.md, content/<scene>.studio.json, src/main.js, src/scripts/, index.html
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
    "version": "0.3.0",
    "entry": "outputs/game/index.html",
    "start": "Codeg Studio preview, or serve a build: npx serve build/game/<version>",
    "build": null
  },
  "paths": { "bible": "bible", "assets": "assets", "outputs": "outputs", "build": "build" },
  "agents": { "writing": null, "art": null, "code": null, "video": null }
}
```

- `schema`: 읽는 쪽은 자기보다 큰 값을 거부한다.
- `outputs`: 정렬·중복 제거된 kebab-case. 없는 결과물 폴더는 만들지 않는다.
- `engine`: game 결과물이 있고 템플릿이 엔진을 제공할 때만 존재. `build`는 패키징 전 실행할 셸 명령(선택). `start`는 사람이 읽는 실행 방법이다. 엔진이 프로젝트 밖에 있으므로 Studio 밖에서 돌리려면 빌드를 서빙한다.
- `paths`: 레이어 위치 선언. 도구는 하드코딩 대신 이 값을 읽는다.
- `agents`: 역할별 선호 에이전트. `null`이면 사용자가 고른 에이전트. 매니페스트에 두는 이유는 프로젝트와 함께 이동하기 위해서다.

## 템플릿

| id | 엔진 | 기본 결과물 |
| --- | --- | --- |
| `story` | 없음 | webtoon, novel |
| `web-three` | `three-web` 0.3.0 (Studio가 제공하는 관리형 런타임 + 벤더링된 Three.js r170, 빌드 단계 없음) | game, video |

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

## 엔진: 프로젝트 밖의 관리형 런타임 (`three-web` 0.3.0)

프로젝트에는 엔진 코드가 없다. `outputs/game/index.html`의 importmap이 `three`와 `codeg-engine`을 `../../__codeg/…`로 연결하고, 그 예약 경로는 앱에 내장된 파일(`src-tauri/engines/`, `src-tauri/src/content_engine.rs`)이 답한다.

| 상황 | `__codeg/`를 누가 주나 |
| --- | --- |
| 미리보기 | 미리보기 서버가 바이너리에서 서빙한다. 폴더에 같은 경로의 파일이 있어도 무시한다 |
| 빌드 | 진입 HTML이 `__codeg/`를 참조하면 빌드 폴더의 같은 상대 경로에 런타임과 Three.js를 써 넣는다. CDN 요청이 없다 |

그래서 Studio가 엔진을 올리면 모든 프로젝트가 같이 올라간다. 프로젝트가 갖는 것은 장면(`content/`), 이 게임의 규칙(`src/main.js`의 `ops`·`setup`, `src/scripts/index.js`), 그리고 API 설명 사본(`ENGINE.md`)이다. 에이전트용 규칙은 스캐폴드된 `AGENTS.md`에 있다: 엔진을 복사해 고치지 말고 스크립트를 쓴다.

편집기와 엔진 사이의 계약:

1. `?scene=<id>`로 장면을 고른다(기본 `main`). `?codeg=edit`면 편집 모드로 시작한다.
2. 로드되면 `parent.postMessage({ type: "codeg:ready", hot, modes, scene })`. `hot: true`면 `codeg:scene`으로 받은 문서를 즉시 다시 그리고, `modes: true`면 `codeg:mode { mode: "edit" | "play" }`를 받는다.
3. **편집 모드**에서는 스크립트·트윈·입력이 멈추고 장면이 문서 그대로 그려진다(선택 상자와 그림이 일치). **플레이 모드**로 가거나 돌아오면 게임 상태가 문서 기준으로 초기화된다. 편집기의 미리보기 토글이 이 메시지를 보낸다.

런타임이 제공하는 것: 노드 핸들(`x` `y` `visible` `rect` `moveBy` `set` `overlaps` `tween`), `engine.state`, 입력(`input.down` `axisX/Y` `pointer`), 이벤트(`update` `pointerdown` `keydown` …), `spawn/despawn`, 내장 스크립트(`float` `spin` `pulse` `blink` `frames` `mover`), `logic.actions` 연산(`toggle` `setVisible` `say` `swapAsset` `setText` `move` `set` `add` `goto` `run` + `if` 조건). 전체는 `src-tauri/engines/three-web/ENGINE.md`.

0.2.x로 만든 프로젝트(자체 `src/main.js` 러너, unpkg의 Three.js)는 그대로 동작한다. 엔진 업그레이드를 받지 않을 뿐이다. 자동 이전 도구는 없다.

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
  | `studio_publish` | `publish_content_build` (`local` 기본, `command`) |

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

## 출시

빌드는 자족적인 정적 사이트다. 출시는 그것을 어딘가에서 서빙하는 것이고, 두 경로가 있다. 결과는 빌드의 `build-info.json`에 `published` 기록으로 남아 빌드 목록에 링크로 보인다.

| 대상 | 동작 | 설정 |
| --- | --- | --- |
| `local` | Studio의 웹 서버가 `/play/<slug>/`로 빌드 폴더를 서빙한다. 인증이 없고(출시니까) 미리보기의 오류 보고 스크립트도 없다. slug는 프로젝트 이름에서 만들고 프로젝트마다 하나이며, 새 빌드를 출시하면 같은 주소가 새 빌드를 가리킨다. "내리기"로 404가 된다 | 없음 |
| `command` | 매니페스트의 `publish.command`를 프로젝트 루트에서 실행하고 출력의 마지막 http(s) URL을 기록한다. 종료 코드가 0이 아니면 실패다 | `codeg-project.json` |

```json
"publish": { "command": "npx wrangler pages deploy $CODEG_BUILD_DIR --project-name my-story" }
```

명령에는 `CODEG_BUILD_DIR` `CODEG_BUILD_ZIP` `CODEG_BUILD_VERSION` `CODEG_PROJECT_NAME` 환경 변수가 주어지고, `{dir}` `{zip}` `{version}` `{name}` 자리표시자도 치환된다. 예: `netlify deploy --prod --dir $CODEG_BUILD_DIR`, `butler push $CODEG_BUILD_ZIP user/game:html5`, `rsync -a $CODEG_BUILD_DIR/ host:/var/www/game/`. 계정과 자격 증명은 호출되는 CLI의 것이다. Studio는 저장하지 않는다.

`local`의 공개 범위는 Studio 서버의 공개 범위와 같다. `codeg-server` 배포에서는 그 서버의 주소로 누구나 열 수 있고, 데스크톱에서는 루프백 리스너(와 켜져 있다면 내장 웹 서비스)가 답하므로 이 기기와 LAN용 링크다. 등록부는 프로젝트가 아니라 데이터 디렉터리의 `published-games.json`에 있어서 프로젝트를 복제해도 출시되지 않는다. 명시적으로 출시한 빌드 폴더만, 미리보기와 같은 경로 제한(점 파일·심링크 탈출 거부)으로 서빙한다.

백엔드 명령: `publish_content_build(root, version?, target)`, `unpublish_content_game(root)`. 에이전트 도구: `studio_publish`.

## 아직 없는 것

- 매니페스트를 읽어 사이드바 폴더를 구분하지 않는다. `FolderDetail.kind` 확장은 DB 마이그레이션을 수반하므로 보류.
- 결과물 추가/제거 UI가 없다. 매니페스트와 폴더를 직접 고친다.
- `agents` 역할을 실제 에이전트 선택에 반영하지 않는다.
- 편집기에서 이미지를 업로드해 `assets/`에 넣는 기능이 없다. 에셋은 에이전트나 사용자가 `assets/`에 두고 장면 파일에 선언한다.
- 외부 호스트용 프리셋 UI가 없다. `publish.command`는 매니페스트에 직접(또는 에이전트가) 적는다.
- 번들러가 필요한 엔진(`engine.build`)은 빌드 버튼에서만 빌드된다. 미리보기 전에 자동으로 돌리지 않는다. 관리형 엔진은 빌드 단계가 없어 해당 없다.
