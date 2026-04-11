# 外观设置增强：缩放与主题色 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为外观设置页面添加 Window Zoom Level（6 档百分比缩放）和 Theme Color（12 个 shadcn 官方预设主题色），所有偏好通过浏览器 `localStorage` 持久化，首次加载无 FOUC，并提供"恢复默认"按钮。

**Architecture:** 采用 shadcn 官方推荐方案——CSS `[data-theme]` 属性选择器 + `:root` 字号 inline style，由 `<head>` 中的同步执行 inline 脚本在 hydration 前写入 DOM 防止闪烁。React 侧由独立的 `<AppearanceProvider>` 管理 state（与 `next-themes` 完全正交），`localStorage` 跨标签页同步。

**Tech Stack:** Next.js 16 (静态导出) · React 19 · TypeScript strict · Tailwind CSS v4 · shadcn/ui · next-themes · next-intl

---

## 关联文档

- 设计文档：`.docs/dev-design/2026-04-11-外观设置增强-缩放与主题色.md`
- 设计文档 commit：`ab49ff4`

## 与设计文档的差异说明

实现前对 `src/app/globals.css` 第 19-50 行做了实际值核对，发现一项需要在实施时调整的细节，**这是对设计文档的微调，不影响整体方案**：

- **设计文档**：默认 `DEFAULT_THEME_COLOR = "zinc"`
- **实际调整**：`DEFAULT_THEME_COLOR = "neutral"`
- **原因**：当前 `globals.css` `:root` 中所有 `oklch(... 0 0)` 都是纯灰阶（chroma=0），与 shadcn 官方 **neutral** 预设完全一致，而 zinc 预设带有微小的蓝色色相 (`oklch(0.21 0.006 285.885)`)。把当前值搬到 `[data-theme="neutral"]` 可以保证升级后视觉 100% 无差。**12 个预设的命名仍然完整保留 zinc**，只是不再作为默认值。

## 文件结构

### 新增文件

| 路径                                       | 职责                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `src/lib/theme-presets.ts`                 | 12 个预设的常量（id 列表 + 类型 + 默认值 + UI 预览代表色 + 缩放档位） |
| `src/lib/appearance-script.ts`             | 防 FOUC inline 脚本字符串 + storage key 常量                      |
| `src/components/appearance-provider.tsx`   | React Context Provider，管理 themeColor / zoomLevel state         |
| `src/hooks/use-appearance.ts`              | 公开 hook：`useAppearance` / `useThemeColor` / `useZoomLevel`     |

### 修改文件

| 路径                                              | 改动                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `src/app/globals.css`                             | 重组：把 `:root` / `.dark` 变量迁到 `[data-theme="neutral"]`，新增 11 个其他预设 |
| `src/app/layout.tsx`                              | `<body>` 顶部注入 inline 脚本；用 `<AppearanceProvider>` 包裹    |
| `src/components/settings/appearance-settings.tsx` | 新增 ThemeColor 卡片、ZoomLevel 卡片、Reset 按钮                  |
| `src/i18n/messages/en.json`                       | 扩展 `AppearanceSettings` 命名空间                                |
| `src/i18n/messages/zh-CN.json`                    | 同上                                                              |
| `src/i18n/messages/zh-TW.json`                    | 同上                                                              |
| `src/i18n/messages/ja.json`                       | 同上                                                              |
| `src/i18n/messages/ko.json`                       | 同上                                                              |
| `src/i18n/messages/es.json`                       | 同上                                                              |
| `src/i18n/messages/de.json`                       | 同上                                                              |
| `src/i18n/messages/fr.json`                       | 同上                                                              |
| `src/i18n/messages/pt.json`                       | 同上                                                              |
| `src/i18n/messages/ar.json`                       | 同上                                                              |

## 任务执行顺序

1. Task 1：常量模块 `theme-presets.ts`
2. Task 2：FOUC 脚本模块 `appearance-script.ts`
3. Task 3：重组 `globals.css` —— 把现有变量迁移到 `[data-theme="neutral"]`（**零视觉差**）
4. Task 4：在 `globals.css` 中追加 11 个其他预设
5. Task 5：Provider + Hooks
6. Task 6：集成 `layout.tsx`（注入脚本 + 嵌套 Provider）
7. Task 7：补齐 10 种语言的 i18n 键
8. Task 8：改造 `appearance-settings.tsx` UI
9. Task 9：手动测试 + 检查清单
10. Task 10：ESLint + build + cargo check + 最终提交

每个 Task 结束都会有一个独立 commit，且每个 commit 后应用都处于可运行状态（i18n 键先于 UI 引入，避免 next-intl 在 UI 引用未定义键时报错）。

---

## Task 1: 创建常量模块 `theme-presets.ts`

**Files:**
- Create: `src/lib/theme-presets.ts`

- [ ] **Step 1：创建文件并写入完整内容**

```ts
// src/lib/theme-presets.ts

/**
 * 12 个 shadcn 官方主题预设的标识符。
 * 实际 CSS 变量值定义在 src/app/globals.css 的 [data-theme="..."] 选择器中。
 */
export const THEME_COLORS = [
  "neutral",
  "zinc",
  "slate",
  "stone",
  "gray",
  "red",
  "rose",
  "orange",
  "green",
  "blue",
  "yellow",
  "violet",
] as const

export type ThemeColor = (typeof THEME_COLORS)[number]

/**
 * 默认主题色。选用 "neutral" 是因为它对应当前 globals.css 的现存 :root 值
 * （所有 chroma=0 的纯灰阶），可保证升级后视觉零差异。
 */
export const DEFAULT_THEME_COLOR: ThemeColor = "neutral"

/**
 * UI 预览用的代表色（OKLch 字符串，对应各预设的 primary 色 light 版本）。
 * 仅用于 Appearance 页面的"色盘圆点"按钮渲染，不会被写入真实样式。
 *
 * 选择 light primary 而非其他变量，是因为 primary 是各预设视觉差异最大的部分。
 * 这些值必须硬编码（不能通过 var(--primary) 读取），因为每个圆点要永远显示
 * 自己对应预设的代表色，不能跟随当前激活的主题色。
 */
export const THEME_COLOR_PREVIEW: Record<ThemeColor, string> = {
  neutral: "oklch(0.205 0 0)",
  zinc: "oklch(0.21 0.006 285.885)",
  slate: "oklch(0.208 0.042 265.755)",
  stone: "oklch(0.216 0.006 56.043)",
  gray: "oklch(0.21 0.034 264.665)",
  red: "oklch(0.637 0.237 25.331)",
  rose: "oklch(0.645 0.246 16.439)",
  orange: "oklch(0.705 0.213 47.604)",
  green: "oklch(0.723 0.219 149.579)",
  blue: "oklch(0.546 0.245 262.881)",
  yellow: "oklch(0.795 0.184 86.047)",
  violet: "oklch(0.606 0.25 292.717)",
}

/**
 * 缩放档位（百分比）。100 是默认。
 * 选用离散档位而非连续滑块，是为了与现有 ThemeMode 选择器保持视觉一致。
 */
export const ZOOM_LEVELS = [80, 90, 100, 110, 125, 150] as const

export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

export const DEFAULT_ZOOM_LEVEL: ZoomLevel = 100
```

- [ ] **Step 2：lint 检查**

Run: `pnpm eslint src/lib/theme-presets.ts`
Expected: 无错误、无警告

- [ ] **Step 3：commit**

```bash
git add src/lib/theme-presets.ts
git commit -m "$(cat <<'EOF'
feat(appearance): add theme presets constants module

定义 12 个 shadcn 主题预设标识、6 档缩放档位以及 UI 预览代表色，
作为后续 AppearanceProvider 和 globals.css 的共享基础。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 创建 FOUC 脚本模块 `appearance-script.ts`

**Files:**
- Create: `src/lib/appearance-script.ts`

- [ ] **Step 1：创建文件并写入完整内容**

```ts
// src/lib/appearance-script.ts

/**
 * Storage keys for appearance preferences.
 * 与 Provider 共享，确保 inline 脚本和 React 层读写同一份数据。
 */
export const STORAGE_KEY_THEME_COLOR = "codeg-theme-color"
export const STORAGE_KEY_ZOOM_LEVEL = "codeg-zoom-level"

/**
 * 同步执行的 inline 脚本，由 layout.tsx 通过 dangerouslySetInnerHTML 注入。
 *
 * 必须在第一帧渲染前完成 <html> 的 data-theme 属性和 font-size 内联样式写入，
 * 否则会出现 FOUC（先看到默认主题/字号，然后切换到用户偏好的闪烁）。
 *
 * 实现要点：
 * 1. 纯字符串，不依赖任何模块导入或外部符号 —— 避免 Next.js 把它当模块编译
 * 2. 白名单校验 —— localStorage 里的值若被篡改或残留旧版本，回退到默认
 * 3. try/catch 包裹 —— 隐私模式 / 嵌入 WebView 禁用 storage 时不抛错
 * 4. 数字常量与 theme-presets.ts 保持一致 —— 任何修改必须两边同步
 */
const SCRIPT = `
(function() {
  try {
    var VALID_COLORS = ["neutral","zinc","slate","stone","gray","red","rose","orange","green","blue","yellow","violet"];
    var VALID_ZOOMS = [80, 90, 100, 110, 125, 150];

    var storedColor = localStorage.getItem("${STORAGE_KEY_THEME_COLOR}");
    var color = VALID_COLORS.indexOf(storedColor) >= 0 ? storedColor : "neutral";
    document.documentElement.setAttribute("data-theme", color);

    var storedZoom = parseInt(localStorage.getItem("${STORAGE_KEY_ZOOM_LEVEL}") || "", 10);
    var zoom = VALID_ZOOMS.indexOf(storedZoom) >= 0 ? storedZoom : 100;
    document.documentElement.style.fontSize = (16 * zoom / 100) + "px";
  } catch (e) {
    // localStorage 不可用时静默走默认
  }
})();
`

export const APPEARANCE_INIT_SCRIPT = SCRIPT
```

- [ ] **Step 2：lint 检查**

Run: `pnpm eslint src/lib/appearance-script.ts`
Expected: 无错误、无警告

- [ ] **Step 3：commit**

```bash
git add src/lib/appearance-script.ts
git commit -m "$(cat <<'EOF'
feat(appearance): add FOUC prevention inline script

提供同步执行的 inline 脚本字符串，在 hydration 前从 localStorage 读取
themeColor 和 zoomLevel 写入 <html>，避免首次加载时的主题/缩放闪烁。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 重组 `globals.css`（迁移 neutral，零视觉差）

**目标**：把现有 `:root` 和 `.dark` 中的 shadcn CSS 变量整体搬到 `[data-theme="neutral"]` 选择器下，同时增加一个 `:root:not([data-theme])` 兜底，**保证升级后视觉零差异**。

**Files:**
- Modify: `src/app/globals.css:8-116`

- [ ] **Step 1：先备份当前的 :root 与 .dark 变量值（用于稍后构造兜底）**

打开文件确认你能看到第 8-116 行的内容，记下：
- 第 19-50 行（`:root` 内的 22 个 `--xxx` 变量定义）= **neutral light**
- 第 53-85 行（`.dark` 内的 24 个变量定义）= **neutral dark**
- 第 87-116 行（`@media (prefers-color-scheme: dark) { :root:not(.light) { ... } }`）= dark 媒体查询兜底

- [ ] **Step 2：替换 `:root` 选择器（第 8-51 行），把变量定义抽离**

将原来的：

```css
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.58 0.22 27);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.94 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}
```

替换为：

```css
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
  --radius: 0.625rem;
}

/* ===========================================================================
   Theme color presets (data-theme attribute)
   每个预设包含成对的 light + dark 变量，与 .dark 类组合生效。
   inline 脚本会在 hydration 前给 <html> 设置 data-theme 属性。
   ========================================================================= */

/* ---------- neutral (default) ---------- */
[data-theme="neutral"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.58 0.22 27);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.94 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

/* 兜底：如果 inline 脚本失败或 data-theme 缺失，回退到 neutral light */
:root:not([data-theme]) {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.58 0.22 27);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.94 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}
```

- [ ] **Step 3：替换 `.dark` 选择器（原第 53-85 行）**

将原来的：

```css
.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.87 0.00 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.371 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.28 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}
```

替换为：

```css
[data-theme="neutral"].dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.87 0.00 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.371 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.28 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

/* 兜底 dark：data-theme 缺失时仍能跟随 .dark 类切换 */
:root:not([data-theme]).dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.87 0.00 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.371 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.28 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}
```

- [ ] **Step 4：保留 `@media (prefers-color-scheme: dark)` 媒体查询，但限定到兜底选择器**

将原来的：

```css
@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    --background: oklch(0.145 0 0);
    /* ... 30 行变量 ... */
    --sidebar-ring: oklch(0.556 0 0);
  }
}
```

替换为：

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]):not(.light) {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.87 0.00 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.371 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.28 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
  }
}
```

注意：选择器从 `:root:not(.light)` 改为 `:root:not([data-theme]):not(.light)` —— 仅在 inline 脚本失败的兜底场景下生效。其他 streamdown / monaco 相关的 `:root:not(.light)` 媒体查询保持原样不动。

- [ ] **Step 5：lint 检查 + build 检查**

Run: `pnpm eslint . && pnpm build`
Expected: 无错误。`pnpm build` 会编译 CSS 并产生静态导出，确认 Tailwind 仍能解析所有 `--color-*` 映射。

- [ ] **Step 6：手动视觉验证（关键）**

Run: `pnpm dev`
打开浏览器：
1. 进入应用主页面 → 检查所有页面的颜色是否与升级前**完全一致**（按钮、卡片、边框、图标）
2. 切换浅色 ↔ 深色模式 → 颜色仍然正确
3. 打开开发者工具，确认 `<html>` 元素上**没有** `data-theme` 属性（此时 inline 脚本还没添加）
4. 颜色应该来自兜底选择器 `:root:not([data-theme])`

如果发现任何视觉差异，说明迁移过程中漏掉/写错了某个变量，回到 Step 2/3/4 校对。

- [ ] **Step 7：commit**

```bash
git add src/app/globals.css
git commit -m "$(cat <<'EOF'
refactor(appearance): migrate base theme tokens to data-theme="neutral"

把现有 :root / .dark 中的 shadcn CSS 变量整体迁移到 [data-theme="neutral"]
和 [data-theme="neutral"].dark 选择器下，并保留 :root:not([data-theme]) 兜底
确保 inline 脚本未生效时仍维持原视觉。这是后续添加 11 个其他主题预设的基础。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 在 `globals.css` 追加其他 11 个主题预设

**Files:**
- Modify: `src/app/globals.css`（在 `:root:not([data-theme]).dark` 块之后、`@media (prefers-color-scheme: dark)` 媒体查询之前插入新内容）

- [ ] **Step 1：在 Task 3 末尾形成的 `:root:not([data-theme]).dark { ... }` 块的紧后方插入 11 组预设**

每组包含 light + dark 两块。完整 CSS 如下，**整段拷贝**：

```css
/* ---------- zinc ---------- */
[data-theme="zinc"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.21 0.006 285.885);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.067);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.21 0.006 285.885);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.705 0.015 286.067);
}
[data-theme="zinc"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.92 0.004 286.32);
  --primary-foreground: oklch(0.21 0.006 285.885);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.552 0.016 285.938);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.552 0.016 285.938);
}

/* ---------- slate ---------- */
[data-theme="slate"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.129 0.042 264.695);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.129 0.042 264.695);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.129 0.042 264.695);
  --primary: oklch(0.208 0.042 265.755);
  --primary-foreground: oklch(0.984 0.003 247.858);
  --secondary: oklch(0.968 0.007 247.896);
  --secondary-foreground: oklch(0.208 0.042 265.755);
  --muted: oklch(0.968 0.007 247.896);
  --muted-foreground: oklch(0.554 0.046 257.417);
  --accent: oklch(0.968 0.007 247.896);
  --accent-foreground: oklch(0.208 0.042 265.755);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.929 0.013 255.508);
  --input: oklch(0.929 0.013 255.508);
  --ring: oklch(0.704 0.04 256.788);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.984 0.003 247.858);
  --sidebar-foreground: oklch(0.129 0.042 264.695);
  --sidebar-primary: oklch(0.208 0.042 265.755);
  --sidebar-primary-foreground: oklch(0.984 0.003 247.858);
  --sidebar-accent: oklch(0.968 0.007 247.896);
  --sidebar-accent-foreground: oklch(0.208 0.042 265.755);
  --sidebar-border: oklch(0.929 0.013 255.508);
  --sidebar-ring: oklch(0.704 0.04 256.788);
}
[data-theme="slate"].dark {
  --background: oklch(0.129 0.042 264.695);
  --foreground: oklch(0.984 0.003 247.858);
  --card: oklch(0.208 0.042 265.755);
  --card-foreground: oklch(0.984 0.003 247.858);
  --popover: oklch(0.208 0.042 265.755);
  --popover-foreground: oklch(0.984 0.003 247.858);
  --primary: oklch(0.929 0.013 255.508);
  --primary-foreground: oklch(0.208 0.042 265.755);
  --secondary: oklch(0.279 0.041 260.031);
  --secondary-foreground: oklch(0.984 0.003 247.858);
  --muted: oklch(0.279 0.041 260.031);
  --muted-foreground: oklch(0.704 0.04 256.788);
  --accent: oklch(0.279 0.041 260.031);
  --accent-foreground: oklch(0.984 0.003 247.858);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.551 0.027 264.364);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.208 0.042 265.755);
  --sidebar-foreground: oklch(0.984 0.003 247.858);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.984 0.003 247.858);
  --sidebar-accent: oklch(0.279 0.041 260.031);
  --sidebar-accent-foreground: oklch(0.984 0.003 247.858);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.551 0.027 264.364);
}

/* ---------- stone ---------- */
[data-theme="stone"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.147 0.004 49.25);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.147 0.004 49.25);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.147 0.004 49.25);
  --primary: oklch(0.216 0.006 56.043);
  --primary-foreground: oklch(0.985 0.001 106.423);
  --secondary: oklch(0.97 0.001 106.424);
  --secondary-foreground: oklch(0.216 0.006 56.043);
  --muted: oklch(0.97 0.001 106.424);
  --muted-foreground: oklch(0.553 0.013 58.071);
  --accent: oklch(0.97 0.001 106.424);
  --accent-foreground: oklch(0.216 0.006 56.043);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.923 0.003 48.717);
  --input: oklch(0.923 0.003 48.717);
  --ring: oklch(0.709 0.01 56.259);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0.001 106.423);
  --sidebar-foreground: oklch(0.147 0.004 49.25);
  --sidebar-primary: oklch(0.216 0.006 56.043);
  --sidebar-primary-foreground: oklch(0.985 0.001 106.423);
  --sidebar-accent: oklch(0.97 0.001 106.424);
  --sidebar-accent-foreground: oklch(0.216 0.006 56.043);
  --sidebar-border: oklch(0.923 0.003 48.717);
  --sidebar-ring: oklch(0.709 0.01 56.259);
}
[data-theme="stone"].dark {
  --background: oklch(0.147 0.004 49.25);
  --foreground: oklch(0.985 0.001 106.423);
  --card: oklch(0.216 0.006 56.043);
  --card-foreground: oklch(0.985 0.001 106.423);
  --popover: oklch(0.216 0.006 56.043);
  --popover-foreground: oklch(0.985 0.001 106.423);
  --primary: oklch(0.923 0.003 48.717);
  --primary-foreground: oklch(0.216 0.006 56.043);
  --secondary: oklch(0.268 0.007 34.298);
  --secondary-foreground: oklch(0.985 0.001 106.423);
  --muted: oklch(0.268 0.007 34.298);
  --muted-foreground: oklch(0.709 0.01 56.259);
  --accent: oklch(0.268 0.007 34.298);
  --accent-foreground: oklch(0.985 0.001 106.423);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.553 0.013 58.071);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.216 0.006 56.043);
  --sidebar-foreground: oklch(0.985 0.001 106.423);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0.001 106.423);
  --sidebar-accent: oklch(0.268 0.007 34.298);
  --sidebar-accent-foreground: oklch(0.985 0.001 106.423);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.553 0.013 58.071);
}

/* ---------- gray ---------- */
[data-theme="gray"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.13 0.028 261.692);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.13 0.028 261.692);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.028 261.692);
  --primary: oklch(0.21 0.034 264.665);
  --primary-foreground: oklch(0.985 0.002 247.839);
  --secondary: oklch(0.967 0.003 264.542);
  --secondary-foreground: oklch(0.21 0.034 264.665);
  --muted: oklch(0.967 0.003 264.542);
  --muted-foreground: oklch(0.551 0.027 264.364);
  --accent: oklch(0.967 0.003 264.542);
  --accent-foreground: oklch(0.21 0.034 264.665);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.928 0.006 264.531);
  --input: oklch(0.928 0.006 264.531);
  --ring: oklch(0.707 0.022 261.325);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0.002 247.839);
  --sidebar-foreground: oklch(0.13 0.028 261.692);
  --sidebar-primary: oklch(0.21 0.034 264.665);
  --sidebar-primary-foreground: oklch(0.985 0.002 247.839);
  --sidebar-accent: oklch(0.967 0.003 264.542);
  --sidebar-accent-foreground: oklch(0.21 0.034 264.665);
  --sidebar-border: oklch(0.928 0.006 264.531);
  --sidebar-ring: oklch(0.707 0.022 261.325);
}
[data-theme="gray"].dark {
  --background: oklch(0.13 0.028 261.692);
  --foreground: oklch(0.985 0.002 247.839);
  --card: oklch(0.21 0.034 264.665);
  --card-foreground: oklch(0.985 0.002 247.839);
  --popover: oklch(0.21 0.034 264.665);
  --popover-foreground: oklch(0.985 0.002 247.839);
  --primary: oklch(0.928 0.006 264.531);
  --primary-foreground: oklch(0.21 0.034 264.665);
  --secondary: oklch(0.278 0.033 256.848);
  --secondary-foreground: oklch(0.985 0.002 247.839);
  --muted: oklch(0.278 0.033 256.848);
  --muted-foreground: oklch(0.707 0.022 261.325);
  --accent: oklch(0.278 0.033 256.848);
  --accent-foreground: oklch(0.985 0.002 247.839);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.551 0.027 264.364);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.034 264.665);
  --sidebar-foreground: oklch(0.985 0.002 247.839);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0.002 247.839);
  --sidebar-accent: oklch(0.278 0.033 256.848);
  --sidebar-accent-foreground: oklch(0.985 0.002 247.839);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.551 0.027 264.364);
}

/* ---------- red ---------- */
[data-theme="red"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.637 0.237 25.331);
  --primary-foreground: oklch(0.971 0.013 17.38);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.637 0.237 25.331);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.637 0.237 25.331);
  --sidebar-primary-foreground: oklch(0.971 0.013 17.38);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.637 0.237 25.331);
}
[data-theme="red"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.637 0.237 25.331);
  --primary-foreground: oklch(0.971 0.013 17.38);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.637 0.237 25.331);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.637 0.237 25.331);
  --sidebar-primary-foreground: oklch(0.971 0.013 17.38);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.637 0.237 25.331);
}

/* ---------- rose ---------- */
[data-theme="rose"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.645 0.246 16.439);
  --primary-foreground: oklch(0.969 0.015 12.422);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.645 0.246 16.439);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.645 0.246 16.439);
  --sidebar-primary-foreground: oklch(0.969 0.015 12.422);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.645 0.246 16.439);
}
[data-theme="rose"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.645 0.246 16.439);
  --primary-foreground: oklch(0.969 0.015 12.422);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.645 0.246 16.439);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.645 0.246 16.439);
  --sidebar-primary-foreground: oklch(0.969 0.015 12.422);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.645 0.246 16.439);
}

/* ---------- orange ---------- */
[data-theme="orange"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.705 0.213 47.604);
  --primary-foreground: oklch(0.98 0.016 73.684);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.213 47.604);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.705 0.213 47.604);
  --sidebar-primary-foreground: oklch(0.98 0.016 73.684);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.705 0.213 47.604);
}
[data-theme="orange"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.646 0.222 41.116);
  --primary-foreground: oklch(0.98 0.016 73.684);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.646 0.222 41.116);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.646 0.222 41.116);
  --sidebar-primary-foreground: oklch(0.98 0.016 73.684);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.646 0.222 41.116);
}

/* ---------- green ---------- */
[data-theme="green"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.723 0.219 149.579);
  --primary-foreground: oklch(0.982 0.018 155.826);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.723 0.219 149.579);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.723 0.219 149.579);
  --sidebar-primary-foreground: oklch(0.982 0.018 155.826);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.723 0.219 149.579);
}
[data-theme="green"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.696 0.17 162.48);
  --primary-foreground: oklch(0.393 0.095 152.535);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.696 0.17 162.48);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.696 0.17 162.48);
  --sidebar-primary-foreground: oklch(0.393 0.095 152.535);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.696 0.17 162.48);
}

/* ---------- blue ---------- */
[data-theme="blue"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.546 0.245 262.881);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.546 0.245 262.881);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.546 0.245 262.881);
  --sidebar-primary-foreground: oklch(0.97 0.014 254.604);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.546 0.245 262.881);
}
[data-theme="blue"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.623 0.214 259.815);
  --primary-foreground: oklch(0.97 0.014 254.604);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.488 0.243 264.376);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.546 0.245 262.881);
  --sidebar-primary-foreground: oklch(0.97 0.014 254.604);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.488 0.243 264.376);
}

/* ---------- yellow ---------- */
[data-theme="yellow"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.795 0.184 86.047);
  --primary-foreground: oklch(0.421 0.095 57.708);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.795 0.184 86.047);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.795 0.184 86.047);
  --sidebar-primary-foreground: oklch(0.421 0.095 57.708);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.795 0.184 86.047);
}
[data-theme="yellow"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.795 0.184 86.047);
  --primary-foreground: oklch(0.421 0.095 57.708);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.554 0.135 66.442);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.795 0.184 86.047);
  --sidebar-primary-foreground: oklch(0.421 0.095 57.708);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.554 0.135 66.442);
}

/* ---------- violet ---------- */
[data-theme="violet"] {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.606 0.25 292.717);
  --primary-foreground: oklch(0.969 0.016 293.756);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.606 0.25 292.717);
  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --chart-3: oklch(0.398 0.07 227.392);
  --chart-4: oklch(0.828 0.189 84.429);
  --chart-5: oklch(0.769 0.188 70.08);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --sidebar-primary: oklch(0.606 0.25 292.717);
  --sidebar-primary-foreground: oklch(0.969 0.016 293.756);
  --sidebar-accent: oklch(0.967 0.001 286.375);
  --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
  --sidebar-border: oklch(0.92 0.004 286.32);
  --sidebar-ring: oklch(0.606 0.25 292.717);
}
[data-theme="violet"].dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.541 0.281 293.009);
  --primary-foreground: oklch(0.969 0.016 293.756);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.541 0.281 293.009);
  --chart-1: oklch(0.488 0.243 264.376);
  --chart-2: oklch(0.696 0.17 162.48);
  --chart-3: oklch(0.769 0.188 70.08);
  --chart-4: oklch(0.627 0.265 303.9);
  --chart-5: oklch(0.645 0.246 16.439);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.541 0.281 293.009);
  --sidebar-primary-foreground: oklch(0.969 0.016 293.756);
  --sidebar-accent: oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.541 0.281 293.009);
}
```

> **来源说明**：以上 OKLch 值来自 shadcn/ui 官方主题 registry（https://ui.shadcn.com/r/themes/）。如果未来想升级到 shadcn 的更新版本，可访问对应的 `<color>.json` 文件并替换。
>
> **chart 颜色策略**：所有预设共用同一组 chart 颜色（即 shadcn 默认 chart-1..5），不随主题色变动。这是有意为之 —— chart 颜色是定性调色板，不应该跟随 UI 主题，否则会损害数据可视化的可读性。

- [ ] **Step 2：lint + build**

Run: `pnpm eslint . && pnpm build`
Expected: 无错误。新增 ~600 行 CSS 不会影响 Tailwind 编译。

- [ ] **Step 3：commit**

```bash
git add src/app/globals.css
git commit -m "$(cat <<'EOF'
feat(appearance): add 11 shadcn theme color presets to globals.css

新增 zinc / slate / stone / gray / red / rose / orange / green / blue / yellow / violet
共 11 个主题预设的 light + dark CSS 变量定义，配合 [data-theme] 选择器使用。
chart 颜色全预设共用，避免数据可视化随主题色失真。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 创建 Provider + Hooks

**Files:**
- Create: `src/components/appearance-provider.tsx`
- Create: `src/hooks/use-appearance.ts`

- [ ] **Step 1：创建 `src/components/appearance-provider.tsx`**

```tsx
"use client"

import { createContext, useCallback, useEffect, useState } from "react"
import {
  THEME_COLORS,
  DEFAULT_THEME_COLOR,
  type ThemeColor,
  ZOOM_LEVELS,
  DEFAULT_ZOOM_LEVEL,
  type ZoomLevel,
} from "@/lib/theme-presets"
import {
  STORAGE_KEY_THEME_COLOR,
  STORAGE_KEY_ZOOM_LEVEL,
} from "@/lib/appearance-script"

type AppearanceContextValue = {
  themeColor: ThemeColor
  setThemeColor: (color: ThemeColor) => void
  zoomLevel: ZoomLevel
  setZoomLevel: (zoom: ZoomLevel) => void
}

export const AppearanceContext = createContext<AppearanceContextValue | null>(
  null
)

/**
 * AppearanceProvider 管理 themeColor 和 zoomLevel 两个外观偏好。
 *
 * 与 next-themes 完全正交：next-themes 负责 <html class="dark/light">，
 * 这里负责 <html data-theme="..."> 和 <html style="font-size: ...">。
 *
 * 注意：next-themes 的 attribute 配置必须保持 "class"。如果改为 "data-theme"
 * 会与本 Provider 冲突，导致主题色无法生效。
 */
export function AppearanceProvider({
  children,
}: {
  children: React.ReactNode
}) {
  // 初始值从 DOM 读取（appearance-script.ts 在 hydration 前已经写好），
  // 而不是从 localStorage 读 —— 避免 SSR 与 CSR 不一致导致的双闪烁。
  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => {
    if (typeof document === "undefined") return DEFAULT_THEME_COLOR
    const attr = document.documentElement.getAttribute(
      "data-theme"
    ) as ThemeColor | null
    return attr && (THEME_COLORS as readonly string[]).includes(attr)
      ? attr
      : DEFAULT_THEME_COLOR
  })

  const [zoomLevel, setZoomLevelState] = useState<ZoomLevel>(() => {
    if (typeof document === "undefined") return DEFAULT_ZOOM_LEVEL
    const px = parseFloat(document.documentElement.style.fontSize || "16")
    const level = Math.round((px / 16) * 100) as ZoomLevel
    return (ZOOM_LEVELS as readonly number[]).includes(level)
      ? level
      : DEFAULT_ZOOM_LEVEL
  })

  const setThemeColor = useCallback((color: ThemeColor) => {
    setThemeColorState(color)
    document.documentElement.setAttribute("data-theme", color)
    try {
      localStorage.setItem(STORAGE_KEY_THEME_COLOR, color)
    } catch {
      // 隐私模式 / 禁用 storage 时静默忽略，本次会话内仍然生效
    }
  }, [])

  const setZoomLevel = useCallback((zoom: ZoomLevel) => {
    setZoomLevelState(zoom)
    document.documentElement.style.fontSize = `${(16 * zoom) / 100}px`
    try {
      localStorage.setItem(STORAGE_KEY_ZOOM_LEVEL, String(zoom))
    } catch {
      // 同上
    }
  }, [])

  // 跨标签页同步：用户在另一个窗口改了设置时，本窗口实时跟进
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_THEME_COLOR && e.newValue) {
        const color = e.newValue as ThemeColor
        if ((THEME_COLORS as readonly string[]).includes(color)) {
          setThemeColorState(color)
          document.documentElement.setAttribute("data-theme", color)
        }
      }
      if (e.key === STORAGE_KEY_ZOOM_LEVEL && e.newValue) {
        const zoom = parseInt(e.newValue, 10) as ZoomLevel
        if ((ZOOM_LEVELS as readonly number[]).includes(zoom)) {
          setZoomLevelState(zoom)
          document.documentElement.style.fontSize = `${(16 * zoom) / 100}px`
        }
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  return (
    <AppearanceContext.Provider
      value={{ themeColor, setThemeColor, zoomLevel, setZoomLevel }}
    >
      {children}
    </AppearanceContext.Provider>
  )
}
```

- [ ] **Step 2：创建 `src/hooks/use-appearance.ts`**

```ts
"use client"

import { useContext } from "react"
import { AppearanceContext } from "@/components/appearance-provider"

export function useAppearance() {
  const ctx = useContext(AppearanceContext)
  if (!ctx) {
    throw new Error("useAppearance must be used within AppearanceProvider")
  }
  return ctx
}

/** 语义化包装：只关心主题色的调用点用这个 */
export function useThemeColor() {
  const { themeColor, setThemeColor } = useAppearance()
  return { themeColor, setThemeColor }
}

/** 语义化包装：只关心缩放档位的调用点用这个 */
export function useZoomLevel() {
  const { zoomLevel, setZoomLevel } = useAppearance()
  return { zoomLevel, setZoomLevel }
}
```

- [ ] **Step 3：lint 检查**

Run: `pnpm eslint src/components/appearance-provider.tsx src/hooks/use-appearance.ts`
Expected: 无错误、无警告

- [ ] **Step 4：commit**

```bash
git add src/components/appearance-provider.tsx src/hooks/use-appearance.ts
git commit -m "$(cat <<'EOF'
feat(appearance): add AppearanceProvider and use-appearance hooks

新增 React Context 管理 themeColor 和 zoomLevel state，与 next-themes 正交，
通过 localStorage 持久化并支持跨标签页同步。提供语义化 hook
useThemeColor / useZoomLevel 供调用点按需使用。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 集成 `layout.tsx`

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1：在文件顶部新增导入**

在 `src/app/layout.tsx` 第 10 行（`import { toIntlLocale } from "@/lib/i18n"` 后面）插入：

```tsx
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance-script"
import { AppearanceProvider } from "@/components/appearance-provider"
```

最终顶部 imports 看起来是：

```tsx
import type { Metadata, Viewport } from "next"
import "katex/dist/katex.min.css"
import "./globals.css"
import { JetBrains_Mono } from "next/font/google"
import { NextIntlClientProvider } from "next-intl"
import { AppI18nProvider } from "@/components/i18n-provider"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { toIntlLocale } from "@/lib/i18n"
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance-script"
import { AppearanceProvider } from "@/components/appearance-provider"
```

- [ ] **Step 2：在 `<body>` 顶部插入 inline 脚本**

将原来的：

```tsx
      <body>
        {/* Suppress benign ResizeObserver loop warnings (W3C spec §3.3) */}
        <script>{`window.addEventListener("error",function(e){if(e.message&&e.message.indexOf("ResizeObserver")!==-1){e.stopImmediatePropagation();e.preventDefault()}});window.onerror=function(m){if(typeof m==="string"&&m.indexOf("ResizeObserver")!==-1)return true}`}</script>
```

替换为：

```tsx
      <body>
        {/* Apply appearance preferences (theme color + zoom) before first paint to prevent FOUC */}
        <script
          dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }}
        />
        {/* Suppress benign ResizeObserver loop warnings (W3C spec §3.3) */}
        <script>{`window.addEventListener("error",function(e){if(e.message&&e.message.indexOf("ResizeObserver")!==-1){e.stopImmediatePropagation();e.preventDefault()}});window.onerror=function(m){if(typeof m==="string"&&m.indexOf("ResizeObserver")!==-1)return true}`}</script>
```

- [ ] **Step 3：用 `<AppearanceProvider>` 包裹 children**

将原来的：

```tsx
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              {children}
            </ThemeProvider>
```

替换为：

```tsx
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <AppearanceProvider>{children}</AppearanceProvider>
            </ThemeProvider>
```

- [ ] **Step 4：lint 检查**

Run: `pnpm eslint src/app/layout.tsx`
Expected: 无错误、无警告

- [ ] **Step 5：build 检查 + 启动 dev server 手动验证**

Run: `pnpm build && pnpm dev`

打开浏览器到任意页面，**打开开发者工具**：
1. 检查 `<html>` 元素：应该有 `data-theme="neutral"` 属性
2. 检查 `<html>` 的 inline style：应该有 `font-size: 16px`
3. 在 Console 执行 `localStorage.setItem("codeg-theme-color", "blue")` → 刷新 → `<html>` 应有 `data-theme="blue"`，主色变蓝
4. 在 Console 执行 `localStorage.setItem("codeg-zoom-level", "125")` → 刷新 → `<html>` 应有 `font-size: 20px`，整个 UI 放大 25%
5. 清理：`localStorage.removeItem("codeg-theme-color"); localStorage.removeItem("codeg-zoom-level")` → 刷新 → 回到默认

- [ ] **Step 6：commit**

```bash
git add src/app/layout.tsx
git commit -m "$(cat <<'EOF'
feat(appearance): wire AppearanceProvider and FOUC script into root layout

在 <body> 顶部注入同步执行的 inline 脚本，在 hydration 前为 <html> 写入
data-theme 属性和 font-size 样式；在 ThemeProvider 内嵌套 AppearanceProvider
管理 React 侧 state。两条通道并行运作，互不干扰。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 补齐 10 种语言的 i18n 键

**Files:**
- Modify: `src/i18n/messages/en.json`
- Modify: `src/i18n/messages/zh-CN.json`
- Modify: `src/i18n/messages/zh-TW.json`
- Modify: `src/i18n/messages/ja.json`
- Modify: `src/i18n/messages/ko.json`
- Modify: `src/i18n/messages/es.json`
- Modify: `src/i18n/messages/de.json`
- Modify: `src/i18n/messages/fr.json`
- Modify: `src/i18n/messages/pt.json`
- Modify: `src/i18n/messages/ar.json`

> 每个文件都需要找到 `"AppearanceSettings"` 对象（例如 `en.json` 第 101 行），定位到 `"resolvedTheme"` 子对象的结束 `}`，在它之后追加新键。下面给出每种语言的完整新增内容。

- [ ] **Step 1：修改 `en.json`**

将原来的：

```json
  "AppearanceSettings": {
    "sectionTitle": "Theme Appearance",
    "sectionDescription": "Choose light, dark, or follow system. Settings are saved automatically.",
    "themeMode": "Theme mode",
    "placeholder": "Select theme mode",
    "system": "Follow system",
    "light": "Light",
    "dark": "Dark",
    "currentTheme": "Current effective theme: {theme}",
    "resolvedTheme": {
      "light": "Light",
      "dark": "Dark",
      "unknown": "--"
    }
  },
```

替换为：

```json
  "AppearanceSettings": {
    "sectionTitle": "Theme Appearance",
    "sectionDescription": "Choose light, dark, or follow system. Settings are saved automatically.",
    "themeMode": "Theme mode",
    "placeholder": "Select theme mode",
    "system": "Follow system",
    "light": "Light",
    "dark": "Dark",
    "currentTheme": "Current effective theme: {theme}",
    "resolvedTheme": {
      "light": "Light",
      "dark": "Dark",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "Theme color",
      "sectionDescription": "Pick a color palette for accents, buttons, and highlights.",
      "current": "Current color: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "Window zoom",
      "sectionDescription": "Scale the entire interface. Applies immediately and persists per device.",
      "placeholder": "Select zoom level",
      "default": "Default",
      "current": "Current zoom: {zoom}%"
    },
    "resetToDefaults": "Reset to defaults",
    "resetHint": "Reset theme color and window zoom to defaults."
  },
```

- [ ] **Step 2：修改 `zh-CN.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "主题外观",
    "sectionDescription": "选择浅色、深色或跟随系统主题，设置会自动保存。",
    "themeMode": "主题模式",
    "placeholder": "请选择主题模式",
    "system": "跟随系统",
    "light": "浅色",
    "dark": "深色",
    "currentTheme": "当前生效主题：{theme}",
    "resolvedTheme": {
      "light": "浅色",
      "dark": "深色",
      "unknown": "未知"
    },
    "themeColor": {
      "sectionTitle": "主题颜色",
      "sectionDescription": "选择按钮、强调色和高亮使用的色调。",
      "current": "当前颜色：{color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "窗口缩放",
      "sectionDescription": "整体放大或缩小界面，立即生效，按设备分别保存。",
      "placeholder": "请选择缩放档位",
      "default": "默认",
      "current": "当前缩放：{zoom}%"
    },
    "resetToDefaults": "恢复默认",
    "resetHint": "将主题颜色和窗口缩放恢复到默认值。"
  },
```

- [ ] **Step 3：修改 `zh-TW.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "主題外觀",
    "sectionDescription": "選擇淺色、深色或跟隨系統主題，設定會自動儲存。",
    "themeMode": "主題模式",
    "placeholder": "請選擇主題模式",
    "system": "跟隨系統",
    "light": "淺色",
    "dark": "深色",
    "currentTheme": "目前生效主題：{theme}",
    "resolvedTheme": {
      "light": "淺色",
      "dark": "深色",
      "unknown": "未知"
    },
    "themeColor": {
      "sectionTitle": "主題顏色",
      "sectionDescription": "選擇按鈕、強調色和高亮使用的色調。",
      "current": "目前顏色：{color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "視窗縮放",
      "sectionDescription": "整體放大或縮小介面，立即生效，依裝置分別儲存。",
      "placeholder": "請選擇縮放檔位",
      "default": "預設",
      "current": "目前縮放：{zoom}%"
    },
    "resetToDefaults": "恢復預設",
    "resetHint": "將主題顏色和視窗縮放恢復到預設值。"
  },
```

- [ ] **Step 4：修改 `ja.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "テーマ外観",
    "sectionDescription": "ライト、ダーク、またはシステムに従うを選択します。設定は自動的に保存されます。",
    "themeMode": "テーマモード",
    "placeholder": "テーマモードを選択",
    "system": "システムに従う",
    "light": "ライト",
    "dark": "ダーク",
    "currentTheme": "現在有効なテーマ：{theme}",
    "resolvedTheme": {
      "light": "ライト",
      "dark": "ダーク",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "テーマカラー",
      "sectionDescription": "ボタンやアクセント、ハイライトに使用する色を選択します。",
      "current": "現在のカラー：{color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "ウィンドウズーム",
      "sectionDescription": "インターフェイス全体を拡大・縮小します。すぐに反映され、デバイスごとに保存されます。",
      "placeholder": "ズームレベルを選択",
      "default": "デフォルト",
      "current": "現在のズーム：{zoom}%"
    },
    "resetToDefaults": "デフォルトに戻す",
    "resetHint": "テーマカラーとウィンドウズームをデフォルトに戻します。"
  },
```

- [ ] **Step 5：修改 `ko.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "테마 모양",
    "sectionDescription": "라이트, 다크 또는 시스템 따르기를 선택하세요. 설정은 자동으로 저장됩니다.",
    "themeMode": "테마 모드",
    "placeholder": "테마 모드 선택",
    "system": "시스템 따르기",
    "light": "라이트",
    "dark": "다크",
    "currentTheme": "현재 적용된 테마: {theme}",
    "resolvedTheme": {
      "light": "라이트",
      "dark": "다크",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "테마 색상",
      "sectionDescription": "버튼, 강조 색상, 하이라이트에 사용할 색상 팔레트를 선택하세요.",
      "current": "현재 색상: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "창 확대/축소",
      "sectionDescription": "전체 인터페이스를 확대하거나 축소합니다. 즉시 적용되며 장치별로 저장됩니다.",
      "placeholder": "확대/축소 단계 선택",
      "default": "기본값",
      "current": "현재 확대/축소: {zoom}%"
    },
    "resetToDefaults": "기본값으로 재설정",
    "resetHint": "테마 색상과 창 확대/축소를 기본값으로 재설정합니다."
  },
```

- [ ] **Step 6：修改 `es.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "Apariencia del tema",
    "sectionDescription": "Elige claro, oscuro o seguir el sistema. La configuración se guarda automáticamente.",
    "themeMode": "Modo del tema",
    "placeholder": "Selecciona el modo del tema",
    "system": "Seguir el sistema",
    "light": "Claro",
    "dark": "Oscuro",
    "currentTheme": "Tema actual: {theme}",
    "resolvedTheme": {
      "light": "Claro",
      "dark": "Oscuro",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "Color del tema",
      "sectionDescription": "Elige una paleta de colores para acentos, botones y resaltados.",
      "current": "Color actual: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "Zoom de ventana",
      "sectionDescription": "Escala toda la interfaz. Se aplica al instante y se guarda por dispositivo.",
      "placeholder": "Selecciona el nivel de zoom",
      "default": "Predeterminado",
      "current": "Zoom actual: {zoom}%"
    },
    "resetToDefaults": "Restablecer valores",
    "resetHint": "Restablece el color del tema y el zoom de ventana a los valores predeterminados."
  },
```

- [ ] **Step 7：修改 `de.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "Design-Erscheinungsbild",
    "sectionDescription": "Wähle Hell, Dunkel oder System folgen. Einstellungen werden automatisch gespeichert.",
    "themeMode": "Design-Modus",
    "placeholder": "Design-Modus wählen",
    "system": "System folgen",
    "light": "Hell",
    "dark": "Dunkel",
    "currentTheme": "Aktuell wirksames Design: {theme}",
    "resolvedTheme": {
      "light": "Hell",
      "dark": "Dunkel",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "Themenfarbe",
      "sectionDescription": "Wähle eine Farbpalette für Akzente, Schaltflächen und Hervorhebungen.",
      "current": "Aktuelle Farbe: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "Fensterzoom",
      "sectionDescription": "Skaliert die gesamte Oberfläche. Wird sofort übernommen und pro Gerät gespeichert.",
      "placeholder": "Zoomstufe wählen",
      "default": "Standard",
      "current": "Aktueller Zoom: {zoom}%"
    },
    "resetToDefaults": "Auf Standard zurücksetzen",
    "resetHint": "Themenfarbe und Fensterzoom auf Standardwerte zurücksetzen."
  },
```

- [ ] **Step 8：修改 `fr.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "Apparence du thème",
    "sectionDescription": "Choisissez clair, sombre ou suivre le système. Les paramètres sont enregistrés automatiquement.",
    "themeMode": "Mode du thème",
    "placeholder": "Sélectionnez le mode du thème",
    "system": "Suivre le système",
    "light": "Clair",
    "dark": "Sombre",
    "currentTheme": "Thème actuellement appliqué : {theme}",
    "resolvedTheme": {
      "light": "Clair",
      "dark": "Sombre",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "Couleur du thème",
      "sectionDescription": "Choisissez une palette pour les accents, les boutons et les surlignages.",
      "current": "Couleur actuelle : {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "Zoom de la fenêtre",
      "sectionDescription": "Met à l'échelle toute l'interface. S'applique immédiatement et est enregistré par appareil.",
      "placeholder": "Sélectionnez le niveau de zoom",
      "default": "Par défaut",
      "current": "Zoom actuel : {zoom}%"
    },
    "resetToDefaults": "Réinitialiser",
    "resetHint": "Réinitialise la couleur du thème et le zoom de la fenêtre."
  },
```

- [ ] **Step 9：修改 `pt.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "Aparência do tema",
    "sectionDescription": "Escolha claro, escuro ou seguir o sistema. As configurações são salvas automaticamente.",
    "themeMode": "Modo do tema",
    "placeholder": "Selecione o modo do tema",
    "system": "Seguir o sistema",
    "light": "Claro",
    "dark": "Escuro",
    "currentTheme": "Tema atualmente em uso: {theme}",
    "resolvedTheme": {
      "light": "Claro",
      "dark": "Escuro",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "Cor do tema",
      "sectionDescription": "Escolha uma paleta de cores para acentos, botões e destaques.",
      "current": "Cor atual: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "Zoom da janela",
      "sectionDescription": "Dimensiona toda a interface. Aplica imediatamente e é salvo por dispositivo.",
      "placeholder": "Selecione o nível de zoom",
      "default": "Padrão",
      "current": "Zoom atual: {zoom}%"
    },
    "resetToDefaults": "Restaurar padrões",
    "resetHint": "Restaura a cor do tema e o zoom da janela para os padrões."
  },
```

- [ ] **Step 10：修改 `ar.json`**

替换 `"AppearanceSettings"` 块为：

```json
  "AppearanceSettings": {
    "sectionTitle": "مظهر السمة",
    "sectionDescription": "اختر فاتح أو داكن أو اتباع النظام. يتم حفظ الإعدادات تلقائياً.",
    "themeMode": "وضع السمة",
    "placeholder": "اختر وضع السمة",
    "system": "اتباع النظام",
    "light": "فاتح",
    "dark": "داكن",
    "currentTheme": "السمة الحالية: {theme}",
    "resolvedTheme": {
      "light": "فاتح",
      "dark": "داكن",
      "unknown": "--"
    },
    "themeColor": {
      "sectionTitle": "لون السمة",
      "sectionDescription": "اختر لوحة ألوان للتمييزات والأزرار والإبرازات.",
      "current": "اللون الحالي: {color}",
      "options": {
        "neutral": "Neutral",
        "zinc": "Zinc",
        "slate": "Slate",
        "stone": "Stone",
        "gray": "Gray",
        "red": "Red",
        "rose": "Rose",
        "orange": "Orange",
        "green": "Green",
        "blue": "Blue",
        "yellow": "Yellow",
        "violet": "Violet"
      }
    },
    "zoomLevel": {
      "sectionTitle": "تكبير النافذة",
      "sectionDescription": "تكبير أو تصغير الواجهة بالكامل. يتم تطبيقه فوراً ويُحفظ لكل جهاز على حدة.",
      "placeholder": "اختر مستوى التكبير",
      "default": "افتراضي",
      "current": "التكبير الحالي: {zoom}%"
    },
    "resetToDefaults": "إعادة الضبط",
    "resetHint": "إعادة ضبط لون السمة وتكبير النافذة إلى الإعدادات الافتراضية."
  },
```

- [ ] **Step 11：JSON 语法检查**

Run: `node -e "['en','zh-CN','zh-TW','ja','ko','es','de','fr','pt','ar'].forEach(l => { JSON.parse(require('fs').readFileSync('src/i18n/messages/' + l + '.json', 'utf8')); console.log(l + ' OK'); })"`
Expected: 10 行 `xx OK` 输出，无 SyntaxError

- [ ] **Step 12：lint + build**

Run: `pnpm eslint . && pnpm build`
Expected: 无错误。Next.js 静态导出会把 i18n messages 打包进 bundle。

- [ ] **Step 13：commit**

```bash
git add src/i18n/messages/
git commit -m "$(cat <<'EOF'
i18n(appearance): add theme color, zoom level, and reset translations

为 10 种语言（en/zh-CN/zh-TW/ja/ko/es/de/fr/pt/ar）的 AppearanceSettings 命名空间
新增 themeColor / zoomLevel / resetToDefaults / resetHint 等键。预设颜色名保留
英文原名以与 shadcn 品牌一致。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 改造 `appearance-settings.tsx` UI

**Files:**
- Modify: `src/components/settings/appearance-settings.tsx`

- [ ] **Step 1：完整重写文件**

整个文件用以下内容**完全替换**：

```tsx
"use client"

import { Monitor, Moon, RotateCcw, Sun, Type } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useThemeColor, useZoomLevel } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"
import {
  DEFAULT_THEME_COLOR,
  DEFAULT_ZOOM_LEVEL,
  THEME_COLOR_PREVIEW,
  THEME_COLORS,
  ZOOM_LEVELS,
  type ThemeColor,
  type ZoomLevel,
} from "@/lib/theme-presets"

type ThemeMode = "system" | "light" | "dark"

export function AppearanceSettings() {
  const t = useTranslations("AppearanceSettings")
  const { theme, resolvedTheme, setTheme } = useTheme()
  const { themeColor, setThemeColor } = useThemeColor()
  const { zoomLevel, setZoomLevel } = useZoomLevel()

  const resolvedThemeLabel =
    resolvedTheme === "dark"
      ? t("resolvedTheme.dark")
      : resolvedTheme === "light"
        ? t("resolvedTheme.light")
        : t("resolvedTheme.unknown")

  const isAtDefaults =
    themeColor === DEFAULT_THEME_COLOR && zoomLevel === DEFAULT_ZOOM_LEVEL

  const handleResetToDefaults = () => {
    setThemeColor(DEFAULT_THEME_COLOR)
    setZoomLevel(DEFAULT_ZOOM_LEVEL)
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4">
        {/* ===== Theme Mode (existing) ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("sectionTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("sectionDescription")}
          </p>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("themeMode")}
            </label>
            <Select
              value={theme ?? "system"}
              onValueChange={(value) => setTheme(value as ThemeMode)}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="system">
                  <span className="inline-flex items-center gap-2">
                    <Monitor className="h-3.5 w-3.5" />
                    {t("system")}
                  </span>
                </SelectItem>
                <SelectItem value="light">
                  <span className="inline-flex items-center gap-2">
                    <Sun className="h-3.5 w-3.5" />
                    {t("light")}
                  </span>
                </SelectItem>
                <SelectItem value="dark">
                  <span className="inline-flex items-center gap-2">
                    <Moon className="h-3.5 w-3.5" />
                    {t("dark")}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p
              className="text-[11px] text-muted-foreground"
              suppressHydrationWarning
            >
              {t("currentTheme", { theme: resolvedThemeLabel })}
            </p>
          </div>
        </section>

        {/* ===== Theme Color (new) ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span
              className="size-4 rounded-full border"
              style={{ backgroundColor: THEME_COLOR_PREVIEW[themeColor] }}
              aria-hidden
            />
            <h2 className="text-sm font-semibold">
              {t("themeColor.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("themeColor.sectionDescription")}
          </p>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {THEME_COLORS.map((color) => {
              const isActive = themeColor === color
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => setThemeColor(color as ThemeColor)}
                  aria-pressed={isActive}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                    isActive && "border-primary ring-2 ring-primary/30"
                  )}
                >
                  <span
                    className="size-4 shrink-0 rounded-full border"
                    style={{ backgroundColor: THEME_COLOR_PREVIEW[color] }}
                    aria-hidden
                  />
                  <span className="truncate">
                    {t(`themeColor.options.${color}`)}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t("themeColor.current", {
              color: t(`themeColor.options.${themeColor}`),
            })}
          </p>
        </section>

        {/* ===== Zoom Level (new) ===== */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Type className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("zoomLevel.sectionTitle")}
            </h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("zoomLevel.sectionDescription")}
          </p>

          <div className="space-y-2">
            <Select
              value={String(zoomLevel)}
              onValueChange={(value) =>
                setZoomLevel(parseInt(value, 10) as ZoomLevel)
              }
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder={t("zoomLevel.placeholder")} />
              </SelectTrigger>
              <SelectContent align="start">
                {ZOOM_LEVELS.map((z) => (
                  <SelectItem key={z} value={String(z)}>
                    {z}%
                    {z === DEFAULT_ZOOM_LEVEL ? ` (${t("zoomLevel.default")})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {t("zoomLevel.current", { zoom: zoomLevel })}
            </p>
          </div>
        </section>

        {/* ===== Reset to defaults (new) ===== */}
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={isAtDefaults}
            onClick={handleResetToDefaults}
            title={t("resetHint")}
          >
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
            {t("resetToDefaults")}
          </Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2：lint 检查**

Run: `pnpm eslint src/components/settings/appearance-settings.tsx`
Expected: 无错误、无警告
（如果报 `cannot find module '@/components/ui/button'` 等错误，确认 shadcn Button 组件已存在 —— 应该早已存在于 `src/components/ui/button.tsx`，无需新增）

- [ ] **Step 3：build 检查 + 浏览器端到端验证**

Run: `pnpm build && pnpm dev`

打开浏览器到 设置 → 外观，期望：
- 三张卡片正常渲染（i18n 键已在 Task 7 中预备好）
- 12 个色盘按钮可点击切换主题色
- 缩放下拉可切换 6 档
- Reset 按钮在默认值时 disabled
- Console 检查 `<html>` 的 `data-theme` 和 `style.fontSize` 随交互更新

如果发现任何缺失的 i18n 键报错，回头补充对应文件（不应该出现，Task 7 已经把所有需要的键加齐）。

- [ ] **Step 4：commit**

```bash
git add src/components/settings/appearance-settings.tsx
git commit -m "$(cat <<'EOF'
feat(appearance): add theme color picker, zoom level selector, reset button

外观设置页新增三个 UI 单元：12 个 shadcn 主题预设的色盘按钮网格、6 档窗口缩放
下拉选择器、以及只重置主题色和缩放（不动主题模式）的恢复默认按钮。
i18n 键在上一个 Task 中已预备好，本提交后整个外观设置功能即可在浏览器中端到端使用。

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 手动测试 + 检查清单

**Files:** 无文件改动。这是一个端到端验证 task。

- [ ] **Step 1：启动 dev server**

Run: `pnpm dev`
等待编译完成，打开浏览器。

- [ ] **Step 2：清空 localStorage 模拟全新用户**

在浏览器开发者工具的 Console：

```js
localStorage.removeItem("codeg-theme-color")
localStorage.removeItem("codeg-zoom-level")
location.reload()
```

期望：
- 页面加载无任何闪烁
- `<html>` 应有 `data-theme="neutral"` 和 `style="font-size: 16px"`
- 视觉效果与升级前完全一致

- [ ] **Step 3：进入 设置 → 外观，验证三张卡片渲染**

期望看到：
1. **Theme Appearance** 卡片（已有）
2. **Theme color** 卡片：12 个色盘按钮（响应式 3/4/6 列），neutral 高亮
3. **Window zoom** 卡片：下拉显示 `100% (Default)`
4. 右下角 **Reset to defaults** 按钮：disabled 灰显（因为当前就是默认值）

- [ ] **Step 4：切换主题色，验证联动**

点击 "Blue"：
- 色盘按钮的高亮 ring 立即变蓝
- 整页所有 primary 色组件（按钮、激活的导航项等）变蓝
- 顶部小色盘圆点变蓝
- "Reset to defaults" 按钮变为可点击
- Console 检查：`localStorage.getItem("codeg-theme-color")` → `"blue"`
- Console 检查：`document.documentElement.getAttribute("data-theme")` → `"blue"`

刷新页面 → Blue 仍然生效，无闪烁。

- [ ] **Step 5：切换缩放档位**

Zoom 选择 `125%`：
- 整个 UI 立即放大 25%
- "Reset to defaults" 按钮仍然可点击
- Console 检查：`localStorage.getItem("codeg-zoom-level")` → `"125"`
- Console 检查：`document.documentElement.style.fontSize` → `"20px"`

刷新页面 → 125% 缩放仍然生效，无闪烁。

- [ ] **Step 6：切换浅色 / 深色模式 + 主题色组合**

切到 Dark 模式：
- 当前 Blue 主题保持，但变成 Blue dark 配色
- 点 Red → Red dark
- 切回 Light → Red light

期望：Theme Mode 和 Theme Color 完全独立，可以任意组合。

- [ ] **Step 7：Reset 按钮**

当前是 Red + 125%，点 **Reset to defaults**：
- 主题色回到 Neutral
- 缩放回到 100%
- **Theme Mode 不变**（仍然是 Light 或 Dark）
- 按钮立即变为 disabled
- Console 检查：`localStorage` 中两个键都被覆盖为默认值

- [ ] **Step 8：跨标签页同步**

打开第二个浏览器标签页到同一应用 → 进入设置 → 外观。
在标签页 A 里切到 Green。
切到标签页 B → 应该实时看到主题色已变 Green，按钮高亮已更新。

- [ ] **Step 9：localStorage 篡改健壮性**

```js
localStorage.setItem("codeg-theme-color", "garbage-value")
localStorage.setItem("codeg-zoom-level", "9999")
location.reload()
```

期望：
- 页面正常加载，无白屏无报错
- `<html data-theme>` 应该是 `"neutral"`（白名单回退）
- `font-size` 应该是 `16px`

- [ ] **Step 10：缩放 150% 下的布局检查**

切到 150%，遍历几个主要页面：
- 主页 / 文件夹页 / 会话页
- 设置 → 各个 tab
- 终端面板
- 命令面板（如果有）

期望：没有明显溢出、错位、内容被截断。如果发现 1-2 处问题，**修一下**（通常是某个固定 px 值需要改成 rem 或 max-w）。如果发现大面积问题，停下记录，先 commit 当前修复，再单独处理。

- [ ] **Step 11：服务器模式验证（可选但推荐）**

Run: `cd src-tauri && cargo build --bin codeg-server --no-default-features` （首次会比较慢）
Run: `cd src-tauri && cargo run --bin codeg-server --no-default-features` （或对应启动方式）
打开 `http://localhost:<port>`，重复 Step 2-7 的关键步骤。

期望：与桌面 Tauri 模式行为完全一致。

- [ ] **Step 12：如果有发现的小问题，分别 commit**

如果在 Step 10 发现某个组件需要适配缩放，单独修复并 commit：

```bash
git add <修改的文件>
git commit -m "fix(<scope>): adapt to window zoom levels"
```

如果一切正常，跳到下一个 Task。

---

## Task 10: 最终全量检查 + 提交

**Files:** 无文件改动。

- [ ] **Step 1：前端全量 lint**

Run: `pnpm eslint .`
Expected: 无错误、无警告。如果有警告（特别是 `unused-imports` 等），回到对应文件清理。

- [ ] **Step 2：前端 build**

Run: `pnpm build`
Expected: 编译成功，静态导出生成于 `out/` 目录。

- [ ] **Step 3：Rust 后端检查（桌面模式）**

Run: `cd src-tauri && cargo check`
Expected: 无错误、无警告（项目用的是 Tauri 默认 feature）。

- [ ] **Step 4：Rust 后端检查（服务器模式）**

Run: `cd src-tauri && cargo check --bin codeg-server --no-default-features`
Expected: 无错误、无警告。

- [ ] **Step 5：Rust clippy**

Run: `cd src-tauri && cargo clippy`
Expected: 无新增警告。

- [ ] **Step 6：git status 确认无未提交改动**

Run: `git status`
Expected: 工作目录干净（除了你想保留的本地 stash 或临时文件）。如果有未提交的修复（来自 Task 9 Step 12），先 commit 它们。

- [ ] **Step 7：查看本次工作的全部 commits**

Run: `git log --oneline ab49ff4..HEAD`
Expected: 8-10 个 feat/refactor/i18n commits（分别对应 Task 1-8，加上 Task 9 中可能的修复 commits）。

如果 commit 数量符合预期且每个 commit 信息清晰，本次实施完成。

---

## 自检清单

实施过程中或完成后，确认以下要点都被满足：

- [ ] `globals.css` 现在有 12 个 `[data-theme="..."]` light 块 + 12 个 `[data-theme="..."].dark` 块 + 兜底 `:root:not([data-theme])` 块（共 25 个 CSS 选择器）
- [ ] `THEME_COLORS` 和 inline 脚本里的 `VALID_COLORS` 数组顺序、长度、内容完全一致
- [ ] `ZOOM_LEVELS` 和 inline 脚本里的 `VALID_ZOOMS` 数组完全一致
- [ ] `STORAGE_KEY_*` 常量在 `appearance-script.ts`、`appearance-provider.tsx`、inline 脚本字符串中都使用相同字面值
- [ ] `next-themes` 的 `attribute` 配置仍然是 `"class"`，**没有**被改成 `"data-theme"`
- [ ] `<html suppressHydrationWarning>` 仍然存在（layout.tsx 里）
- [ ] 所有 10 个语言文件都新增了 `themeColor` / `zoomLevel` / `resetToDefaults` / `resetHint` 键，且 JSON 语法合法
- [ ] 所有预设颜色名（neutral, zinc, ...) 在 i18n 中保留英文（与 shadcn 品牌一致）
- [ ] Theme Color 按钮的色盘圆点用 inline `style={{ backgroundColor }}` 而非 CSS 类（保证圆点显示自己的代表色而非当前激活色）
- [ ] Reset 按钮**只重置** Theme Color 和 Zoom Level，**不动** Theme Mode
- [ ] Reset 按钮在默认值时 disabled
- [ ] Monaco editor 等组件没有被改动，它们的硬编码 fontSize 不跟随 Zoom Level（这是有意为之）
