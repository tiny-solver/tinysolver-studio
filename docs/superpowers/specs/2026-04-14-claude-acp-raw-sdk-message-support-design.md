# Claude ACP Raw SDK Message Support Design

- Date: 2026-04-14
- Status: Approved (implementation pending)
- Scope: Protocol support only (backend receives and forwards, frontend event layer receives)

## 1. Background

Upstream PR `agentclientprotocol/claude-agent-acp#527` was merged on **2026-04-13**.
It introduces opt-in emission of Claude Code SDK raw stream messages via ACP extension notification:

- Method: `"_claude/sdkMessage"`
- Params shape:
  - `sessionId: string`
  - `message: object` (raw SDK message)

Opt-in is configured via session `_meta`:

```json
{
  "claudeCode": {
    "emitRawSDKMessages": true
  }
}
```

User decision for this project:

- Keep npm/registry at current version (`0.27.0`)
- Implement **protocol support only**
- Enable raw SDK messages for Claude by default with `true`

## 2. Goals and Non-Goals

### Goals

1. For `AgentType::ClaudeCode`, send `_meta.claudeCode.emitRawSDKMessages = true` in session setup.
2. Receive `"_claude/sdkMessage"` notifications in backend connection loop.
3. Convert and forward notifications to frontend via existing `acp://event` event bridge.
4. Extend frontend `AcpEvent` typing to accept this event without changing UI behavior.

### Non-Goals

1. No UI visualization for raw SDK messages in this change.
2. No DB persistence for raw SDK messages.
3. No behavior changes for non-Claude agents.
4. No protocol generalization for all extension notifications in this iteration.

## 3. Selected Approach

Selected approach: **Claude-specific minimal integration**.

Why:

- Minimal risk and smallest change surface.
- Matches explicit scope: protocol plumbing only.
- Preserves current runtime and rendering behavior.

Rejected for now:

- Global extension-notification bus (larger scope, more noise, higher maintenance).
- Persistence/debug history (extra storage and lifecycle complexity).

## 4. Architecture Changes

## 4.1 Backend session meta injection

File: `src-tauri/src/acp/connection.rs`

When constructing `NewSessionRequest` and `LoadSessionRequest`:

- If `agent_type == AgentType::ClaudeCode`, set request `meta` with:
  - `claudeCode.emitRawSDKMessages = true`

This preserves opt-in semantics upstream while default-enabling for Claude in Codeg.

## 4.2 Backend extension notification handling

File: `src-tauri/src/acp/connection.rs`

Current code mainly consumes typed `SessionNotification` updates. This change adds a path for untyped notifications:

- Match dispatch notification method.
- If method is `"_claude/sdkMessage"`, parse params:
  - `sessionId`
  - `message`
- Emit new app event through `acp://event`.
- Ignore parse failures and continue session loop.

## 4.3 Backend event model extension

File: `src-tauri/src/acp/types.rs`

Add a new `AcpEvent` variant:

- `ClaudeSdkMessage`
  - `connection_id: String`
  - `session_id: String`
  - `message: serde_json::Value`

This keeps payload raw and unopinionated.

## 4.4 Frontend type and event switch support

Files:

- `src/lib/types.ts`
- `src/contexts/acp-connections-context.tsx`

Changes:

- Extend TS `AcpEvent` union with:
  - `type: "claude_sdk_message"`
  - `connection_id: string`
  - `session_id: string`
  - `message: unknown`
- Add a no-op `case "claude_sdk_message"` in event handling.

No UI state mutation is required in this iteration.

## 5. Data Flow

1. Codeg starts Claude ACP session.
2. Codeg sends `session/new` or `session/load` with `_meta.claudeCode.emitRawSDKMessages=true`.
3. `claude-agent-acp` emits extension notifications `"_claude/sdkMessage"`.
4. Codeg backend parses and maps to `AcpEvent::claude_sdk_message`.
5. Event is pushed via existing `acp://event` channel.
6. Frontend receives typed event and safely ignores it (for now).

## 6. Error Handling and Compatibility

1. If upstream ignores meta, session still works; feature simply produces no raw SDK events.
2. If `"_claude/sdkMessage"` payload is malformed, log and ignore that notification.
3. Do not fail prompt/session loops due to extension-message parse errors.
4. Keep all existing typed `SessionUpdate` flows unchanged.
5. Restrict meta injection to Claude only.

## 7. Validation Plan

Manual/protocol validation:

1. Confirm session setup request includes `_meta.claudeCode.emitRawSDKMessages=true` for Claude.
2. Confirm `"_claude/sdkMessage"` notifications are received and forwarded as `claude_sdk_message` events.
3. Confirm malformed ext payloads do not break turns.
4. Confirm non-Claude agents have unchanged behavior.

Project checks:

1. `pnpm eslint .`
2. `pnpm build`
3. `cd src-tauri && cargo check`
4. `cd src-tauri && cargo check --bin codeg-server --no-default-features`

## 8. Acceptance Criteria

1. Claude connections default-enable raw SDK emission via session meta.
2. Backend forwards raw SDK notifications into frontend event layer.
3. Frontend compiles and receives new event type without UI regressions.
4. No persistence and no visual rendering changes.
5. No regressions on existing ACP message paths.
