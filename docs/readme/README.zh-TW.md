# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB)](https://tauri.app/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)](../../Dockerfile)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <strong>繁體中文</strong> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）是一個企業級多 Agent 編碼工作台。
它將本地 AI 編碼代理（Claude Code、Codex CLI、OpenCode、Gemini CLI、
OpenClaw、Cline 等）整合到桌面應用與 Web 服務中——透過瀏覽器即可遠端開發——支援會話彙整、並行 `git worktree`
開發、MCP/Skills 管理，以及整合的 Git/檔案/終端工作流。

## 主介面
![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## 會話平鋪顯示
![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

## 設定
| 代理 | MCP | Skills | 版本控制 | Web 服務 |
| :---: | :---: | :---: | :---: | :---: |
| ![Agents](../images/1-light.png#gh-light-mode-only) ![Agents](../images/1-dark.png#gh-dark-mode-only) | ![MCP](../images/2-light.png#gh-light-mode-only) ![MCP](../images/2-dark.png#gh-dark-mode-only) | ![Skills](../images/3-light.png#gh-light-mode-only) ![Skills](../images/3-dark.png#gh-dark-mode-only) | ![Version Control](../images/4-light.png#gh-light-mode-only) ![Version Control](../images/4-dark.png#gh-dark-mode-only) | ![Web Service](../images/5-light.png#gh-light-mode-only) ![Web Service](../images/5-dark.png#gh-dark-mode-only) |

## 核心亮點

- 同一專案中的多 Agent 統一工作台
- 本地會話解析與結構化渲染
- 內建 `git worktree` 並行開發流程
- **專案啟動器** — 視覺化建立新專案，即時預覽效果
- MCP 管理（本地掃描 + 市場搜尋/安裝）
- Skills 管理（全域與專案級）
- Git 遠端帳號管理（支援 GitHub 及其他 Git 伺服器）
- Web 服務模式 — 開啟後可在瀏覽器中存取 Codeg，支援遠端工作
- **獨立伺服器部署** — 在任意 Linux/macOS 伺服器上執行 `codeg-server`，透過瀏覽器存取
- **Docker 支援** — 使用 `docker compose up` 部署，零設定啟動服務
- 整合工程閉環（檔案樹、Diff、Git 變更、提交、終端）

## 專案啟動器

視覺化建立新專案：左側設定面板，右側即時預覽。

![Project Boot Light](../images/project-boot-light.png#gh-light-mode-only)
![Project Boot Dark](../images/project-boot-dark.png#gh-dark-mode-only)

### 功能特色

- **視覺化設定** — 從下拉選單中選擇樣式、色彩主題、圖示庫、字型、圓角等，預覽面板即時更新
- **即時預覽** — 在建立專案前，即時檢視所選樣式的渲染效果
- **一鍵建立** — 點擊「建立專案」，啟動器將使用您的預設設定、框架範本（Next.js / Vite / React Router / Astro / Laravel）和套件管理器（pnpm / npm / yarn / bun）執行 `shadcn init`
- **套件管理器偵測** — 自動偵測已安裝的套件管理器並顯示版本號
- **無縫整合** — 新建立的專案會立即在 Codeg 工作台中開啟

目前支援 **shadcn/ui** 專案腳手架，分頁式設計為未來支援更多專案類型做好了準備。

## 支援範圍

### 1) 會話解析（歷史會話）

| Agent | 環境變數優先路徑 | macOS / Linux 預設路徑 | Windows 預設路徑 |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |
| OpenClaw | — | `~/.openclaw/agents` | `%USERPROFILE%\\.openclaw\\agents` |
| Cline | `$CLINE_DIR` | `~/.cline/data/tasks` | `%USERPROFILE%\\.cline\\data\\tasks` |

> 注意：環境變數的優先順序高於預設路徑。

### 2) ACP 即時會話

目前支援 6 種代理：Claude Code、Codex CLI、Gemini CLI、OpenCode 和 OpenClaw。

### 3) Skills 設定支援

- 已支援：`Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw / Cline`
- 更多適配器將持續補齊

### 4) MCP 目標應用

目前可寫入的目標：

- Claude Code
- Codex
- OpenCode

## 快速開始

### 環境需求

- Node.js `>=22`（建議）
- pnpm `>=10`
- Rust stable（2021 edition）
- Tauri 2 建置依賴（僅桌面模式）

Linux（Debian/Ubuntu）範例：

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

### 開發命令

```bash
pnpm install

# 前端靜態匯出到 out/
pnpm build

# 完整桌面應用（Tauri + Next.js）
pnpm tauri dev

# 僅前端
pnpm dev

# 桌面應用建置
pnpm tauri build

# 獨立伺服器（無需 Tauri/GUI）
pnpm server:dev

# 建置伺服器發行版二進位檔
pnpm server:build

# Lint
pnpm eslint .

# Rust 檢查（在 src-tauri/ 下執行）
cargo check
cargo clippy
cargo build
```

### 伺服器部署

Codeg 可以作為獨立 Web 伺服器執行，無需桌面環境。

#### 方式一：一鍵安裝（Linux / macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
```

安裝指定版本或到自訂目錄：

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash -s -- --version v0.5.0 --dir ~/.local/bin
```

然後執行：

```bash
codeg-server
```

#### 方式二：一鍵安裝（Windows PowerShell）

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
```

或安裝指定版本：

```powershell
.\install.ps1 -Version v0.5.0
```

#### 方式三：從 GitHub Releases 下載

預建置二進位檔（已打包 Web 前端資源）可在 [Releases](https://github.com/xintaofei/codeg/releases) 頁面下載：

| 平台 | 檔案 |
| --- | --- |
| Linux x64 | `codeg-server-linux-x64.tar.gz` |
| Linux arm64 | `codeg-server-linux-arm64.tar.gz` |
| macOS x64 | `codeg-server-darwin-x64.tar.gz` |
| macOS arm64 | `codeg-server-darwin-arm64.tar.gz` |
| Windows x64 | `codeg-server-windows-x64.zip` |

```bash
# 範例：下載、解壓縮、執行
tar xzf codeg-server-linux-x64.tar.gz
cd codeg-server-linux-x64
CODEG_STATIC_DIR=./web ./codeg-server
```

#### 方式四：Docker

```bash
docker compose up -d

# 或直接執行
docker run -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

#### 方式五：從原始碼建置

```bash
pnpm install && pnpm build          # 建置前端
cd src-tauri
cargo build --release --bin codeg-server --no-default-features
CODEG_STATIC_DIR=../out ./target/release/codeg-server
```

#### 設定

環境變數：

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `CODEG_PORT` | `3080` | HTTP 連接埠 |
| `CODEG_HOST` | `0.0.0.0` | 綁定位址 |
| `CODEG_TOKEN` | *（隨機）* | 認證令牌（啟動時輸出到 stderr） |
| `CODEG_DATA_DIR` | `~/.local/share/codeg` | SQLite 資料庫目錄 |
| `CODEG_STATIC_DIR` | `./web` 或 `./out` | Next.js 靜態匯出目錄 |

## 架構

```text
Next.js 16 (Static Export) + React 19
        |
        | invoke() (desktop) / fetch() + WebSocket (web)
        v
  ┌─────────────────────────┐
  │   Transport Abstraction  │
  │  (Tauri IPC or HTTP/WS) │
  └─────────────────────────┘
        |
        v
┌─── Tauri Desktop ───┐    ┌─── codeg-server ───┐
│  Tauri 2 Commands    │    │  Axum HTTP + WS    │
│  (window management) │    │  (standalone mode)  │
└──────────┬───────────┘    └──────────┬──────────┘
           └──────────┬───────────────┘
                      v
            Shared Rust Core
              |- AppState
              |- ACP Manager
              |- Parsers (session ingestion)
              |- Git / File Tree / Terminal
              |- MCP marketplace + config
              |- SeaORM + SQLite
                      |
                      v
        Local Filesystem / Git Repos
```

## 開發約束

- 前端使用靜態匯出（`output: "export"`）
- 不使用 Next.js 動態路由（`[param]`），改用查詢參數
- Tauri 命令參數：前端 `camelCase`，Rust `snake_case`
- TypeScript strict 模式

## 隱私與安全

- 預設本地優先：解析、儲存、專案操作均在本地完成
- 僅在使用者主動觸發時才存取網路
- 支援系統代理，適配企業網路環境
- Web 服務模式使用基於令牌的身份認證

## 授權

Apache-2.0，詳見 `LICENSE`。
