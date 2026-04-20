"use client"

export type SidebarViewMode = "flat" | "grouped"

const VIEW_MODE_KEY = "workspace:sidebar-view-mode"
const FOLDER_EXPANDED_KEY = "workspace:sidebar-folder-expanded"

export function loadSidebarViewMode(): SidebarViewMode {
  if (typeof window === "undefined") return "flat"
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY)
    if (raw === "flat" || raw === "grouped") return raw
  } catch {
    /* ignore */
  }
  return "flat"
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function loadFolderExpanded(): Record<number, boolean> {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(FOLDER_EXPANDED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    const result: Record<number, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(k)
      if (!Number.isNaN(id) && typeof v === "boolean") {
        result[id] = v
      }
    }
    return result
  } catch {
    return {}
  }
}

export function saveFolderExpanded(state: Record<number, boolean>): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}
