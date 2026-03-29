# Codeg

[![Release](https://img.shields.io/github/v/release/xintaofei/codeg)](https://github.com/xintaofei/codeg/releases)
[![License](https://img.shields.io/github/license/xintaofei/codeg)](../../LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB)](https://tauri.app/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)](../../Dockerfile)

<p>
  <a href="../../README.md">English</a> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.zh-TW.md">繁體中文</a> |
  <strong>日本語</strong> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.pt.md">Português</a> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg（Code Generation）は、エンタープライズ級のマルチ Agent コーディングワークスペースです。
Claude Code、Codex CLI、OpenCode、Gemini CLI、OpenClaw などのローカル AI コーディング Agent を
デスクトップアプリと Web サービスに統合し——ブラウザからどこでもリモート開発が可能——セッション集約、並列 `git worktree` 開発、MCP/Skills 管理、
Git/ファイル/ターミナル連携ワークフローを提供します。

## メインインターフェース
![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## セッションタイル表示
![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

## 設定
| エージェント | MCP | Skills | バージョン管理 | Web サービス |
| :---: | :---: | :---: | :---: | :---: |
| ![Agents](../images/1-light.png#gh-light-mode-only) ![Agents](../images/1-dark.png#gh-dark-mode-only) | ![MCP](../images/2-light.png#gh-light-mode-only) ![MCP](../images/2-dark.png#gh-dark-mode-only) | ![Skills](../images/3-light.png#gh-light-mode-only) ![Skills](../images/3-dark.png#gh-dark-mode-only) | ![Version Control](../images/4-light.png#gh-light-mode-only) ![Version Control](../images/4-dark.png#gh-dark-mode-only) | ![Web Service](../images/5-light.png#gh-light-mode-only) ![Web Service](../images/5-dark.png#gh-dark-mode-only) |

## ハイライト

- 同一プロジェクトでのマルチ Agent 統合ワークスペース
- ローカルセッションの取り込みと構造化レンダリング
- 内蔵 `git worktree` フローによる並列開発
- **プロジェクトブート** — ビジュアル設定とライブプレビューで新規プロジェクトを作成
- MCP 管理（ローカルスキャン + レジストリ検索/インストール）
- Skills 管理（グローバルおよびプロジェクトスコープ）
- Git リモートアカウント管理（GitHub およびその他の Git サーバー）
- Web サービスモード — ブラウザから Codeg にアクセスでき、リモートワークに対応
- **スタンドアロンサーバーデプロイ** — 任意の Linux/macOS サーバーで `codeg-server` を実行し、ブラウザからアクセス
- **Docker サポート** — `docker compose up` でゼロ設定のサーバーセットアップが可能
- 統合エンジニアリングループ（ファイルツリー、Diff、Git 変更、コミット、ターミナル）

## プロジェクトブート

分割ペインインターフェースで新規プロジェクトをビジュアルに作成：左側で設定、右側でリアルタイムプレビュー。

![Project Boot Light](../images/project-boot-light.png#gh-light-mode-only)
![Project Boot Dark](../images/project-boot-dark.png#gh-dark-mode-only)

### 主な機能

- **ビジュアル設定** — ドロップダウンからスタイル、カラーテーマ、アイコンライブラリ、フォント、角丸などを選択でき、プレビューが即座に更新
- **ライブプレビュー** — プロジェクト作成前に、選んだルック＆フィールをリアルタイムで確認
- **ワンクリック作成** — 「プロジェクト作成」をクリックすると、プリセット設定、フレームワークテンプレート（Next.js / Vite / React Router / Astro / Laravel）、パッケージマネージャー（pnpm / npm / yarn / bun）で `shadcn init` を実行
- **パッケージマネージャー検出** — インストール済みのパッケージマネージャーを自動検出し、バージョンを表示
- **シームレスな統合** — 新規作成されたプロジェクトは、すぐに Codeg のワークスペースで開きます

現在 **shadcn/ui** プロジェクトのスキャフォールディングをサポートしており、タブベースの設計で将来のプロジェクトタイプ追加に対応しています。

## 対応範囲

### 1) セッション取り込み（履歴セッション）

| Agent | 環境変数パス | macOS / Linux デフォルト | Windows デフォルト |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |
| OpenClaw | — | `~/.openclaw/agents` | `%USERPROFILE%\\.openclaw\\agents` |
| Cline | `$CLINE_DIR` | `~/.cline/data/tasks` | `%USERPROFILE%\\.cline\\data\\tasks` |

> 注: 環境変数はフォールバックパスより優先されます。

### 2) ACP リアルタイムセッション

現在、Claude Code、Codex CLI、Gemini CLI、OpenCode、OpenClaw、Cline の 6 つのエージェントをサポートしています。

### 3) Skills 設定サポート

- 対応済み: `Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw / Cline`
- 他のアダプターは順次追加予定

### 4) MCP ターゲットアプリ

現在の書き込み対象:

- Claude Code
- Codex
- OpenCode

## クイックスタート

### 必要条件

- Node.js `>=22`（推奨）
- pnpm `>=10`
- Rust stable（2021 edition）
- Tauri 2 ビルド依存パッケージ（デスクトップモードのみ）

Linux（Debian/Ubuntu）の例:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

### 開発

```bash
pnpm install

# フロントエンド静的エクスポート（out/ へ）
pnpm build

# デスクトップアプリ全体（Tauri + Next.js）
pnpm tauri dev

# フロントエンドのみ
pnpm dev

# デスクトップビルド
pnpm tauri build

# スタンドアロンサーバー（Tauri/GUI 不要）
pnpm server:dev

# サーバーリリースバイナリのビルド
pnpm server:build

# Lint
pnpm eslint .

# Rust チェック（src-tauri/ で実行）
cargo check
cargo clippy
cargo build
```

### サーバーデプロイ

Codeg はデスクトップ環境なしでスタンドアロン Web サーバーとして実行できます。

#### オプション 1: ワンラインインストール（Linux / macOS）

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
```

特定のバージョンまたはカスタムディレクトリにインストール:

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash -s -- --version v0.5.0 --dir ~/.local/bin
```

実行:

```bash
codeg-server
```

#### オプション 2: ワンラインインストール（Windows PowerShell）

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
```

または特定のバージョンをインストール:

```powershell
.\install.ps1 -Version v0.5.0
```

#### オプション 3: GitHub Releases からダウンロード

ビルド済みバイナリ（Web アセットをバンドル済み）は [Releases](https://github.com/xintaofei/codeg/releases) ページからダウンロードできます:

| プラットフォーム | ファイル |
| --- | --- |
| Linux x64 | `codeg-server-linux-x64.tar.gz` |
| Linux arm64 | `codeg-server-linux-arm64.tar.gz` |
| macOS x64 | `codeg-server-darwin-x64.tar.gz` |
| macOS arm64 | `codeg-server-darwin-arm64.tar.gz` |
| Windows x64 | `codeg-server-windows-x64.zip` |

```bash
# 例: ダウンロード、解凍、実行
tar xzf codeg-server-linux-x64.tar.gz
cd codeg-server-linux-x64
CODEG_STATIC_DIR=./web ./codeg-server
```

#### オプション 4: Docker

```bash
docker compose up -d

# または直接実行
docker run -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

#### オプション 5: ソースからビルド

```bash
pnpm install && pnpm build          # フロントエンドをビルド
cd src-tauri
cargo build --release --bin codeg-server --no-default-features
CODEG_STATIC_DIR=../out ./target/release/codeg-server
```

#### 設定

環境変数:

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `CODEG_PORT` | `3080` | HTTP ポート |
| `CODEG_HOST` | `0.0.0.0` | バインドアドレス |
| `CODEG_TOKEN` | *(ランダム)* | 認証トークン（起動時に stderr に出力） |
| `CODEG_DATA_DIR` | `~/.local/share/codeg` | SQLite データベースディレクトリ |
| `CODEG_STATIC_DIR` | `./web` または `./out` | Next.js 静的エクスポートディレクトリ |

## アーキテクチャ

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

## 制約事項

- フロントエンドは静的エクスポートを使用（`output: "export"`）
- Next.js の動的ルート（`[param]`）は不可。代わりにクエリパラメータを使用
- Tauri コマンドパラメータ: フロントエンドは `camelCase`、Rust は `snake_case`
- TypeScript strict モード

## プライバシーとセキュリティ

- 解析、ストレージ、プロジェクト操作はデフォルトでローカルファースト
- ネットワークアクセスはユーザーが明示的に操作した場合のみ発生
- エンタープライズ環境向けのシステムプロキシサポート
- Web サービスモードではトークンベースの認証を使用

## ライセンス

Apache-2.0。`LICENSE` を参照してください。
