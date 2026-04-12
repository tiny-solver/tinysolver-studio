# OverlayScrollbars Migration Design

Replace native CSS scrollbar styling (`.scrollbar-thin` / `.scrollbar-thin-edge`) with OverlayScrollbars for cross-platform consistency, richer behavior, and visual customization.

## Motivation

- Native `scrollbar-width: thin` is unsupported on Safari/WebKit
- No hover/active states or auto-hide behavior with native CSS
- Recent `scrollbar-gutter` removal (commit `db6da4a`) highlights ongoing layout-shift issues that OverlayScrollbars solves by design

## Approach

App-level provider for body scroll + thin `<ScrollArea>` wrapper component for per-element containers.

## 1. Dependencies & CSS Setup

### New packages

- `overlayscrollbars` (core)
- `overlayscrollbars-react` (React wrapper)

### CSS changes in `globals.css`

Import the library CSS:

```css
@import "overlayscrollbars/overlayscrollbars.css";
```

Define custom theme `os-theme-codeg`:

```css
.os-theme-codeg {
  --os-size: 6px;
  --os-handle-bg: var(--border);
  --os-handle-bg-hover: var(--muted-foreground);
  --os-handle-bg-active: var(--muted-foreground);
  --os-handle-border-radius: 999px;
  --os-handle-perpendicular-size: 100%;
  --os-handle-perpendicular-size-hover: 100%;
  --os-handle-perpendicular-size-active: 100%;
}

/* Grow handle on hover */
.os-theme-codeg:hover {
  --os-size: 8px;
}
```

Key visual properties:
- **Size:** 6px default, 8px on hover
- **Handle color:** `var(--border)` — matches current scrollbar color, respects dark/light theme
- **Handle hover/active:** `var(--muted-foreground)` for a noticeable but not jarring contrast bump
- **Handle shape:** fully rounded (999px border-radius)
- **Track:** transparent (no background)

### Cleanup

- Delete the old unified `.scrollbar-thin, .scrollbar-thin-edge` rule (lines ~1005-1011)
- Keep a minimal compat rule for the virtua component:

```css
.scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
```

## 2. Global Body Scroll Initialization

In the root layout component (likely `src/app/layout.tsx` or a client wrapper):

- Use `useOverlayScrollbars` hook to initialize on `document.body`
- Run once on mount via `useEffect`
- Options:
  - `scrollbars.theme`: `'os-theme-codeg'`
  - `scrollbars.autoHide`: `'leave'`
  - `scrollbars.clickScroll`: `true`
  - `overflow.x`: `'hidden'`
- `defer: true` for idle-time initialization

## 3. `<ScrollArea>` Wrapper Component

**File:** `src/components/ui/scroll-area.tsx`

### API

```tsx
<ScrollArea className="flex-1 min-h-0" x="hidden">
  {children}
</ScrollArea>
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `children` | `ReactNode` | — | Content |
| `className` | `string` | — | Applied to root element (sizing/layout) |
| `x` | `'scroll' \| 'hidden'` | `'hidden'` | Horizontal overflow |
| `y` | `'scroll' \| 'hidden'` | `'scroll'` | Vertical overflow |
| `ref` | `Ref` | — | Forwarded to `OverlayScrollbarsComponent` |

### Internals

- Renders `<OverlayScrollbarsComponent>` with `defer={true}`
- Hardcoded defaults: `theme: 'os-theme-codeg'`, `autoHide: 'leave'`, `clickScroll: true`
- Merges `x`/`y` props into `overflow` options
- No `options` prop passthrough — keeps API simple; can be added later if needed

## 4. Migration: 12 Usages Across 7 Files

Each migration replaces `<div className="... overflow-y-auto scrollbar-thin ...">` with `<ScrollArea className="...">`. The `overflow-*` and `scrollbar-*` classes are dropped; other layout classes stay.

| File | Usages | Current class |
|------|--------|---------------|
| `sidebar-conversation-list.tsx` | 1 | `scrollbar-thin` |
| `file-workspace-panel.tsx` | 1 | `scrollbar-thin` |
| `unified-diff-preview.tsx` | 3 | `scrollbar-thin` |
| `aux-panel-git-log-tab.tsx` | 4 | `scrollbar-thin` |
| `aux-panel-session-files-tab.tsx` | 1 | `scrollbar-thin` |
| `aux-panel-git-changes-tab.tsx` | 1 | `scrollbar-thin-edge` |
| `aux-panel-file-tree-tab.tsx` | 1 | `scrollbar-thin-edge` |

### Skipped

- `virtualized-message-thread.tsx` — keeps native `.scrollbar-thin` class. Virtua manages its own scroll container; OverlayScrollbars integration with virtua is deferred to a future task.

## 5. Verification

After migration, verify:

1. `pnpm eslint .` passes
2. `pnpm build` succeeds
3. Manual check: scrollbars appear on hover/scroll in all migrated containers, hide when pointer leaves
4. Body scroll works with overlay scrollbar
5. Virtua message thread still scrolls correctly with native fallback
