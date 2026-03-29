# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

codeg 是一个多模式应用，支持桌面客户端和独立服务器部署，用于聚合和浏览本地 AI 编码代理的会话记录。它从多个代理（Claude Code、Codex、OpenCode、Gemini CLI、OpenClaw、Cline）的本地文件系统中读取会话数据，统一格式后在 UI 中展示。

## 技术栈

- **桌面运行时**: Tauri 2（Rust 后端 + webview 前端）
- **服务器运行时**: 独立 Rust 二进制（Axum HTTP + WebSocket，无需 Tauri/GUI）
- **前端**: Next.js 16（静态导出模式）+ React 19 + TypeScript（strict）
- **样式**: Tailwind CSS v4 + shadcn/ui（radix-maia 风格）
- **包管理器**: pnpm

## 开发命令

```bash
# 启动完整桌面应用（Tauri + Next.js Turbopack 开发服务器）
pnpm tauri dev

# 仅启动前端
pnpm dev

# 构建前端（静态导出到 out/）
pnpm build

# 构建 Tauri 桌面应用
pnpm tauri build

# 启动独立服务器（无需 Tauri/GUI）
pnpm server:dev

# 构建服务器 release 二进制
pnpm server:build

# Lint 检查
pnpm eslint .

# Rust 检查（在 src-tauri/ 目录下执行）
cargo check                                                    # 桌面模式（默认）
cargo check --bin codeg-server --no-default-features           # 服务器模式
cargo clippy
cargo build
```

目前尚未配置测试框架。

## 架构

### 双模式运行

项目通过 Cargo feature flags 支持两种运行模式：

- **`tauri-runtime`（默认）**：完整桌面应用，包含 Tauri 窗口管理、系统通知、自动更新等
- **无 feature（`--no-default-features`）**：独立服务器模式，仅编译 Axum HTTP API + WebSocket

### 共享核心

- **`app_state.rs`** — `AppState` 共享状态结构，两种模式通过 `EventEmitter` 枚举区分事件发射方式
- **`web/event_bridge.rs`** — `EventEmitter::Tauri(AppHandle)` 或 `EventEmitter::WebOnly(Arc<WebEventBroadcaster>)`
- **`web/router.rs`** — Axum 路由，接受 `Arc<AppState>`
- **`web/handlers/`** — 146 个 HTTP API 端点，全部使用 `Extension<Arc<AppState>>`

### Rust 后端（`src-tauri/src/`）

后端负责读取和解析本地文件系统上的代理会话文件：

- **`app_state.rs`** — 共享状态（db、连接管理器、终端管理器、事件广播器）
- **`models/`** — 共享数据结构
- **`parsers/`** — 每个代理一个解析器
- **`commands/`** — 业务逻辑（`_core` 函数供两种模式共用，`#[tauri::command]` 函数仅桌面模式）
- **`web/`** — Axum HTTP API + WebSocket + 静态文件服务
- **`acp/`** — Agent Client Protocol 连接管理
- **`terminal/`** — PTY 终端管理
- **`db/`** — SeaORM + SQLite

### 前端（`src/`）

- **`lib/transport/`** — Transport 抽象层，自动检测 Tauri/Web 环境切换 `invoke()`/`fetch()`
- **`lib/types.ts`** — Rust 模型的 TypeScript 镜像
- **`app/`** — Next.js 页面，不使用动态路由
- **`app/login/`** — Web 模式 token 登录页
- **`components/`** — 项目组件
- **`components/ui/`** — shadcn 组件

### 数据流

桌面模式：前端 `invoke()` → Tauri 命令 → 业务逻辑 → 返回数据
服务器模式：前端 `fetch()` → Axum HTTP API → 同一业务逻辑 → 返回 JSON

### 条件编译约定

- `#[cfg(feature = "tauri-runtime")]` — 仅桌面模式编译（Tauri 窗口、通知、`tauri::State` 参数等）
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]` — 函数始终可用，仅在桌面模式标记为 Tauri 命令
- `_core` 后缀函数 — 接受普通引用参数（`&AppDatabase`、`&EventEmitter`），供 Web handlers 和 Tauri 命令共用

## 关键约束

- **仅支持静态导出**：`next.config.ts` 设置 `output: "export"`，不支持动态路由（`[param]`），必须使用查询参数替代
- **路径别名**：`@/*` 映射到 `./src/*`，导入写法为 `@/lib/utils`、`@/components/ui/button`
- **Rust serde 约定**：`AgentType` 序列化为 snake_case（`claude_code`、`open_code`）。Tauri 命令参数在 JS 侧使用 camelCase，Rust 侧使用 snake_case
- **服务器部署**：通过环境变量配置（`CODEG_PORT`、`CODEG_HOST`、`CODEG_TOKEN`、`CODEG_DATA_DIR`、`CODEG_STATIC_DIR`）

## 代码风格

- Prettier：无分号、尾逗号（es5）、2 空格缩进、80 字符宽度
- ESLint：next/core-web-vitals + typescript + prettier
- TypeScript：strict 模式，启用 `noUnusedLocals` 和 `noUnusedParameters`
- Rust：2021 edition，使用 `thiserror` 定义错误类型
