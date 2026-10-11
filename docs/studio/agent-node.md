# 흐름 안 에이전트 — agent 노드 (L4)

흐름(`flows/<id>.flow.json`) 노드 하나가 에이전트 루프 한 번이다. 목표 한 줄 · 쓸 부품 · 멈출 조건을 받아 ACP 세션(Claude Code · Codex)을 사람 없이 돌리고, 끝나면 결과 · 대화 기록 · 걸음 수 · 시간 · 비용을 실행 기록(`runs/`)에 남긴다.
계획: my-devops `docs/plans/tinysolver/studio-layers.md` ② · decide `layers-l4-agent`.

## 노드 모양

```json
{
  "kind": "agent",
  "id": "fix-scene",
  "agent": "claude",
  "goal": "장면 intro 의 배경을 밤으로 바꾸고 조명을 하나 줄인다",
  "tools": ["list_scenes", "read_scene", "apply_commands"],
  "input": "${nodes.pick.output}",
  "stop": { "max_turns": 30, "max_seconds": 600, "max_cost_usd": 0.5 },
  "output": {
    "type": "object",
    "required": ["scene", "changed"],
    "properties": { "scene": { "type": "string" }, "changed": { "type": "integer" } }
  },
  "mode": null
}
```

| 칸 | 뜻 | 없으면 |
|---|---|---|
| `agent` | `claude` · `codex` | 필수 |
| `goal` | 목표 한 줄 — 첫 프롬프트 맨 앞 | 필수 |
| `tools` | 부품 레지스트리 이름(`read_scene`) 또는 MCP 이름(`studio_read_scene`) | 부품 없음 |
| `input` | 앞 노드 결과 — L3 의 `${…}` 참조로 풀어 첫 프롬프트에 JSON 으로 | 안 넣음 |
| `stop.max_turns` | 도구 호출 수 상한(걸음) | 30 |
| `stop.max_seconds` | 시간 상한 | 600 |
| `stop.max_cost_usd` | 세션 비용 상한 — 에이전트가 비용을 알려 줄 때만(claude) | 없음 |
| `output` | 나오는 것 JSON Schema — 마지막 메시지의 ```json 블록을 `model_once` 와 같은 검사기(jsonschema)로 맞춰 본다 | 마지막 글이 결과 |
| `mode` | 에이전트 모드(claude `default` · `acceptEdits` …) | 에이전트 기본 |

## 실행 — `studio_agent_node::run_agent_node`

자동화 엔진(`automation/engine.rs`)과 같은 길이라 서버 모드(`codeg-server`, linux-1)에서도 돈다.

1. 부품 목록을 owner 라벨 `studio_agent:<uuid>` 에 묶어 둔다.
2. `spawn_agent`(프로젝트 폴더 · 새 세션) → 대화 줄 `흐름 · <목표>` → 첫 프롬프트(목표 · 넣는 것 · 쓸 부품 · 상한 · 나오는 것 모양).
3. 이벤트 버스에서 그 세션만 본다.
   - `ToolCall` → 걸음 +1 · 상한 넘으면 취소
   - `UsageUpdate` → 세션 비용 · 상한 넘으면 취소
   - `PermissionRequest` → 아래 "권한"
   - `TurnComplete(end_turn)` → 마지막 메시지에서 결과를 꺼내 모양 검사 · 안 맞으면 "모양에 맞게 다시" 를 2번까지 · 그래도 안 맞으면 `bad_output`
   - 시간 상한 → 취소 · 취소 뒤 20초 안에 답이 없으면 끊는다
4. 세션을 끊고, 대화 기록은 에이전트 세션 파일에서 다시 읽어(`get_folder_conversation_core`) 결과에 붙인다.

결과(`AgentNodeOutcome`) — L3 는 이것을 `NodeRecord.output` 에 통째로 넣고, `cost_usd` 를 실행 비용에 더하고, `ok: false` 면 노드 실패로 본다.

```json
{ "ok": true, "output": { "scene": "intro", "changed": 3 }, "text": "…",
  "stop_reason": "done", "turns": 1, "steps": 7, "duration_ms": 84210,
  "cost_usd": 0.18, "conversation_id": 412, "transcript": { "turns": [] },
  "asks": [{ "tool": "mcp__codeg-mcp__studio_apply_scene_commands", "title": "…", "answer": "allowed" }] }
```

`stop_reason`: `done` · `max_turns` · `max_seconds` · `max_cost` · `bad_output` · 에이전트 자신의 이유(`refusal` · `max_tokens` …) · `error`.

## 부품 좁히기 — 두 겹

| 겹 | 어디서 | 무엇 |
|---|---|---|
| 보이는 것 | `acp/connection.rs` MCP 서버 조립 뒤 `narrow_mcp_servers` 한 줄 | 노드 세션이면 `codeg-mcp` 만 남기고(사용자 MCP 서버 뺌) `--features studio` 로 — 위임 · 묻기 · 자동화 · 할 일 · 브라우저 도구가 없다. 노드가 도우미를 또 띄우거나 옆문을 열지 못하게 |
| 목록 | companion 환경 `CODEG_STUDIO_TOOLS` + `companion.rs` `allows_tool` 한 줄 | `tools/list` 에 노드 부품만 뜬다(이름은 L0 레지스트리로 부품 ↔ 도구) |
| 부르는 것 | `acp/delegation/listener.rs` `process_studio` 한 줄 `token_allows` | 노드 토큰으로 온 `studio_*` 호출이 목록 밖이면 `ok: false` · note. 목록이 등록 안 된 노드 라벨은 빈 목록(닫힘) |

에이전트 자신의 도구(Claude Code 의 Read · Edit · Bash, Codex 셸)는 MCP 밖이라 여기서 막지 않는다 — 권한 묻기로 걸러진다.

## 권한 — human 카드로

| 무엇을 묻나 | 답 |
|---|---|
| 목록 안 `studio_*` 부품 | 자동 허용(`allow_once`) |
| 그 밖(파일 고치기 · 셸 · 목록 밖 부품) | `AskHuman` 이 있으면 흐름의 살아 있는 human 카드(L3 `ask_live`)로 올려 대표님 답을 기다린다 — 기다리는 동안도 시간 상한은 간다 |
| 묻을 곳이 없을 때 · 멈추는 중 | 거절(`reject_once`) |

묻고 답한 것은 모두 `asks` 에 남는다.

## L3 와 합치는 자리

- L3 `studio_flows.rs` 의 `NodeKind::Agent` 팔 → `run_agent_node(AgentNodeCtx::from_app_state(..), 프로젝트, spec, input, ask)` 로 바꾼다.
- `ask` = L3 `Exec::ask_live(Card{ ask: title, show: 선택지 이름, pick: one })` 를 감싼 것.
- 끝 보고 해 보기: 흐름 하나에서 agent 노드가 장면 하나를 목표대로 고치고 멈춘다 → 웹 실행 기록에 대화 · 결과.
