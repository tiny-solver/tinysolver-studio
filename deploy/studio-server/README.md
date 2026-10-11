# Studio 서버 모드 — linux-1 · studio.home.tinysolver.me

대표님이 쓰는 Studio 는 linux-1 에서 서버 모드(`codeg-server`)로 늘 돈다 (decide `layers-where` A).
네이티브 앱은 남에게 주는 길로 남는다. 계획: my-devops `docs/plans/tinysolver/studio-layers.md` ③.

| 자리 | 값 |
|---|---|
| 주소 | <https://studio.home.tinysolver.me> (LAN · Tailscale) — mac-mini-2 TLS → linux-1 Traefik file 라우터 → `:3180` |
| 토큰 | Vault `secret/tinysolver/studio/server` 의 `TOKEN` → `~/.config/tinysolver-studio/server.env` (600) |
| 설치 자리 | `~/.local/share/tinysolver-studio/{bin,web,data,launch.sh,deployed.json}` |
| 콘텐츠 프로젝트 | `STUDIO_PROJECTS_DIR` (기본 `~/tinysolver.me/studio-projects`) · 기본 프로젝트 `STUDIO_PROJECT`(server.env) |
| 유닛 | `systemctl --user status studio-server` · `journalctl --user -u studio-server -f` |

업스트림 codeg 플릿 서버(`:3080` · `~/.local/share/codeg`)와 포트 · 데이터 · 바이너리를 나눈다.

## 배포

```bash
cd ~/tinysolver.me/tinysolver-studio     # main 체크아웃
deploy/studio-server/deploy.sh            # 빌드 → 설치 → 다시 띄움 → 확인
deploy/studio-server/deploy.sh --check    # 확인만
```

**태그를 붙이지 않는다.** 이 repo 의 `v*.*.*` 는 앱 릴리스(업스트림 `release.yml`)라 stage.sh 식 CalVer 태그를
붙이면 앱 빌드가 같이 돈다(decide `bo-home` 근거). 무엇이 도는지는 `deployed.json`(커밋 · 시각).

## 입구 셋 — 같은 부품 목록(`studio_ops.json`)에서

| 입구 | 부르는 법 |
|---|---|
| HTTP MCP | `POST /mcp` (Streamable HTTP · JSON 응답 · 상태 없음) — 도구 = `studio_list_projects` + 레지스트리의 `studio_*` |
| API | `GET /api/studio/ops` (목록 · 스키마) · `POST /api/studio/<op>` (몸 = 인자 JSON · `project` 선택) |
| CLI | `studio op run <op> [--json '{…}'] [--project <이름>]` — 서버 API 를 부르는 얇은 판 (`STUDIO_URL` · `STUDIO_TOKEN`) |

모두 `Authorization: Bearer <토큰>`. 실패는 HTTP 200 의 `{ ok: false, note }` 로 온다(부품 규칙 그대로).

`project` — 절대 경로, 또는 `STUDIO_PROJECTS_DIR` 아래 폴더 이름. 없으면 `STUDIO_PROJECT`, 그것도 없으면
그 아래 콘텐츠 프로젝트가 하나뿐일 때 그것.

```bash
T=$(vault kv get -field=TOKEN secret/tinysolver/studio/server)
curl -s -H "Authorization: Bearer $T" https://studio.home.tinysolver.me/api/studio/ops | jq '.ops[].op'
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{}' https://studio.home.tinysolver.me/api/studio/list_assets | jq
```

## Claude Desktop 에 붙이기

Claude Desktop 의 '사용자 지정 커넥터'는 Anthropic 클라우드에서 붙어서 LAN 주소에 닿지 않는다.
그래서 맥에서 도는 다리(`mcp-remote`, stdio ↔ HTTP)로 붙인다. 맥북에서 한 줄:

```bash
bash ~/k-codepoet/my-devops/scripts/studio-desktop-connect.sh   # 토큰은 linux-1 Vault 에서 받아 설정에 넣는다
```

Claude Desktop 을 다시 켜고 "Studio 재료 목록 보여 줘".
