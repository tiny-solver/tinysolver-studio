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
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.fr.md">Français</a> |
  <strong>Português</strong> |
  <a href="./README.ar.md">العربية</a>
</p>

Codeg (Code Generation) é um workspace de codificação multi-agentes de nível empresarial.
Ele unifica agentes de codificação IA locais (Claude Code, Codex CLI, OpenCode, Gemini CLI,
OpenClaw, Cline, etc.) em um aplicativo desktop e um serviço web — possibilitando o desenvolvimento remoto a partir de qualquer navegador — com agregação de sessões, desenvolvimento
paralelo via `git worktree`, gerenciamento de MCP/Skills e fluxos integrados de Git/arquivos/terminal.

## Interface principal
![Codeg Light](../images/main-light.png#gh-light-mode-only)
![Codeg Dark](../images/main-dark.png#gh-dark-mode-only)

## Exibição em mosaico das sessões
![Codeg Light](../images/main2-light.png#gh-light-mode-only)
![Codeg Dark](../images/main2-dark.png#gh-dark-mode-only)

## Configurações
| Agentes | MCP | Skills | Controle de versão | Serviço web |
| :---: | :---: | :---: | :---: | :---: |
| ![Agents](../images/1-light.png#gh-light-mode-only) ![Agents](../images/1-dark.png#gh-dark-mode-only) | ![MCP](../images/2-light.png#gh-light-mode-only) ![MCP](../images/2-dark.png#gh-dark-mode-only) | ![Skills](../images/3-light.png#gh-light-mode-only) ![Skills](../images/3-dark.png#gh-dark-mode-only) | ![Version Control](../images/4-light.png#gh-light-mode-only) ![Version Control](../images/4-dark.png#gh-dark-mode-only) | ![Web Service](../images/5-light.png#gh-light-mode-only) ![Web Service](../images/5-dark.png#gh-dark-mode-only) |

## Destaques

- Workspace multi-agentes unificado no mesmo projeto
- Ingestão local de sessões com renderização estruturada
- Desenvolvimento paralelo com fluxos `git worktree` integrados
- **Inicializador de Projeto** — crie novos projetos visualmente com pré-visualização em tempo real
- Gerenciamento de MCP (varredura local + busca/instalação no registro)
- Gerenciamento de Skills (escopo global e por projeto)
- Gerenciamento de contas remotas Git (GitHub e outros servidores Git)
- Modo de serviço web — acesse o Codeg de qualquer navegador para trabalho remoto
- **Implantação de servidor standalone** — execute `codeg-server` em qualquer servidor Linux/macOS, acesse via navegador
- **Suporte a Docker** — implante com `docker compose up` para configuração zero do servidor
- Ciclo de engenharia integrado (árvore de arquivos, diff, alterações git, commit, terminal)

## Inicializador de Projeto

Crie novos projetos visualmente com uma interface de painel dividido: configure à esquerda, pré-visualize em tempo real à direita.

![Project Boot Light](../images/project-boot-light.png#gh-light-mode-only)
![Project Boot Dark](../images/project-boot-dark.png#gh-dark-mode-only)

### O que oferece

- **Configuração visual** — selecione estilo, tema de cores, biblioteca de ícones, fonte, raio de borda e mais nos menus suspensos; o iframe de pré-visualização atualiza instantaneamente
- **Pré-visualização ao vivo** — veja o visual escolhido renderizado em tempo real antes de criar qualquer coisa
- **Criação com um clique** — clique em "Criar Projeto" e o launcher executa `shadcn init` com seu preset, template de framework (Next.js / Vite / React Router / Astro / Laravel) e gerenciador de pacotes (pnpm / npm / yarn / bun)
- **Detecção de gerenciadores de pacotes** — verifica automaticamente quais gerenciadores estão instalados e exibe suas versões
- **Integração perfeita** — o projeto recém-criado abre diretamente no workspace do Codeg

Atualmente suporta scaffolding de projetos **shadcn/ui**, com um design baseado em abas preparado para mais tipos de projetos no futuro.

## Escopo suportado

### 1) Ingestão de sessões (sessões históricas)

| Agente | Caminho por variável de ambiente | Padrão macOS / Linux | Padrão Windows |
| --- | --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` | `~/.claude/projects` | `%USERPROFILE%\\.claude\\projects` |
| Codex CLI | `$CODEX_HOME/sessions` | `~/.codex/sessions` | `%USERPROFILE%\\.codex\\sessions` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `~/.local/share/opencode/opencode.db` | `%USERPROFILE%\\.local\\share\\opencode\\opencode.db` |
| Gemini CLI | `$GEMINI_CLI_HOME/.gemini` | `~/.gemini` | `%USERPROFILE%\\.gemini` |
| OpenClaw | — | `~/.openclaw/agents` | `%USERPROFILE%\\.openclaw\\agents` |
| Cline | `$CLINE_DIR` | `~/.cline/data/tasks` | `%USERPROFILE%\\.cline\\data\\tasks` |

> Nota: as variáveis de ambiente têm prioridade sobre os caminhos padrão.

### 2) Sessões em tempo real ACP

Atualmente suporta 6 agentes: Claude Code, Codex CLI, Gemini CLI, OpenCode, OpenClaw e Cline.

### 3) Suporte a configurações de Skills

- Suportado: `Claude Code / Codex / OpenCode / Gemini CLI / OpenClaw / Cline`
- Mais adaptadores serão adicionados progressivamente

### 4) Aplicativos alvo MCP

Alvos de escrita atuais:

- Claude Code
- Codex
- OpenCode

## Início rápido

### Requisitos

- Node.js `>=22` (recomendado)
- pnpm `>=10`
- Rust stable (2021 edition)
- Dependências de build do Tauri 2 (somente modo desktop)

Exemplo Linux (Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

### Desenvolvimento

```bash
pnpm install

# Exportação estática do frontend para out/
pnpm build

# Aplicativo desktop completo (Tauri + Next.js)
pnpm tauri dev

# Apenas frontend
pnpm dev

# Build do aplicativo desktop
pnpm tauri build

# Servidor standalone (sem Tauri/GUI necessário)
pnpm server:dev

# Build do binário do servidor
pnpm server:build

# Lint
pnpm eslint .

# Verificações Rust (executar em src-tauri/)
cargo check
cargo clippy
cargo build
```

### Implantação do servidor

O Codeg pode ser executado como um servidor web standalone sem ambiente desktop.

#### Opção 1: Instalação em uma linha (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
```

Instalar uma versão específica ou em um diretório personalizado:

```bash
curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash -s -- --version v0.5.0 --dir ~/.local/bin
```

Em seguida, executar:

```bash
codeg-server
```

#### Opção 2: Instalação em uma linha (Windows PowerShell)

```powershell
irm https://raw.githubusercontent.com/xintaofei/codeg/main/install.ps1 | iex
```

Ou instalar uma versão específica:

```powershell
.\install.ps1 -Version v0.5.0
```

#### Opção 3: Baixar do GitHub Releases

Binários pré-compilados (com recursos web incluídos) estão disponíveis na página de [Releases](https://github.com/xintaofei/codeg/releases):

| Plataforma | Arquivo |
| --- | --- |
| Linux x64 | `codeg-server-linux-x64.tar.gz` |
| Linux arm64 | `codeg-server-linux-arm64.tar.gz` |
| macOS x64 | `codeg-server-darwin-x64.tar.gz` |
| macOS arm64 | `codeg-server-darwin-arm64.tar.gz` |
| Windows x64 | `codeg-server-windows-x64.zip` |

```bash
# Exemplo: baixar, extrair e executar
tar xzf codeg-server-linux-x64.tar.gz
cd codeg-server-linux-x64
CODEG_STATIC_DIR=./web ./codeg-server
```

#### Opção 4: Docker

```bash
docker compose up -d

# Ou executar diretamente
docker run -p 3080:3080 -v codeg-data:/data ghcr.io/xintaofei/codeg:latest
```

#### Opção 5: Compilar a partir do código-fonte

```bash
pnpm install && pnpm build          # compilar frontend
cd src-tauri
cargo build --release --bin codeg-server --no-default-features
CODEG_STATIC_DIR=../out ./target/release/codeg-server
```

#### Configuração

Variáveis de ambiente:

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `CODEG_PORT` | `3080` | Porta HTTP |
| `CODEG_HOST` | `0.0.0.0` | Endereço de bind |
| `CODEG_TOKEN` | *(aleatório)* | Token de autenticação (impresso no stderr ao iniciar) |
| `CODEG_DATA_DIR` | `~/.local/share/codeg` | Diretório do banco de dados SQLite |
| `CODEG_STATIC_DIR` | `./web` ou `./out` | Diretório de exportação estática do Next.js |

## Arquitetura

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

## Restrições

- O frontend usa exportação estática (`output: "export"`)
- Sem rotas dinâmicas do Next.js (`[param]`); use parâmetros de consulta em vez disso
- Parâmetros de comandos Tauri: `camelCase` no frontend, `snake_case` no Rust
- TypeScript em modo strict

## Privacidade e segurança

- Local-first por padrão para análise, armazenamento e operações do projeto
- O acesso à rede ocorre apenas em ações iniciadas pelo usuário
- Suporte a proxy do sistema para ambientes corporativos
- O modo de serviço web usa autenticação baseada em token

## Licença

Apache-2.0. Veja `LICENSE`.
