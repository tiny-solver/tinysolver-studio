"use client"

const QUICK_ACTIONS_TAB_KEY = "workspace:quick-actions-tab"

/** Which skill group the welcome-page quick actions show. */
export type QuickActionsTab = "office" | "coding" | "research" | "creative"

const TABS: readonly QuickActionsTab[] = [
  "office",
  "coding",
  "research",
  "creative",
]

export function isQuickActionsTab(value: unknown): value is QuickActionsTab {
  return (
    typeof value === "string" && (TABS as readonly string[]).includes(value)
  )
}

/**
 * Last-picked quick-actions tab, restored when a new conversation opens.
 * Defaults to "coding" (this is a coding workbench first); an absent or
 * polluted value falls back to that default.
 */
export function loadQuickActionsTab(): QuickActionsTab {
  if (typeof window === "undefined") return "coding"
  try {
    const raw = localStorage.getItem(QUICK_ACTIONS_TAB_KEY)
    if (isQuickActionsTab(raw)) return raw
  } catch {
    /* ignore */
  }
  return "coding"
}

export function saveQuickActionsTab(value: QuickActionsTab): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(QUICK_ACTIONS_TAB_KEY, value)
  } catch {
    /* ignore */
  }
}
