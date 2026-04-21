"use client"

const FOLDER_EXPANDED_KEY = "workspace:sidebar-folder-expanded"
const SHOW_COMPLETED_KEY = "workspace:sidebar-show-completed"

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

export function loadShowCompleted(): boolean {
  if (typeof window === "undefined") return false
  try {
    const raw = localStorage.getItem(SHOW_COMPLETED_KEY)
    if (raw === "true") return true
  } catch {
    /* ignore */
  }
  return false
}

export function saveShowCompleted(value: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(SHOW_COMPLETED_KEY, String(value))
  } catch {
    /* ignore */
  }
}
