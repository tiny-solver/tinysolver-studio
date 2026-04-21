"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { useAppWorkspace } from "@/contexts/app-workspace-context"
import type { FolderDetail } from "@/lib/types"

interface ActiveFolderContextValue {
  activeFolderId: number | null
  activeFolder: FolderDetail | null
}

const ActiveFolderContext = createContext<ActiveFolderContextValue | null>(null)

export function useActiveFolder() {
  const ctx = useContext(ActiveFolderContext)
  if (!ctx) {
    throw new Error("useActiveFolder must be used within ActiveFolderProvider")
  }
  return ctx
}

export function ActiveFolderProvider({ children }: { children: ReactNode }) {
  const { allFolders, activeFolderId } = useAppWorkspace()

  const activeFolder = useMemo(
    () =>
      activeFolderId != null
        ? (allFolders.find((f) => f.id === activeFolderId) ?? null)
        : null,
    [activeFolderId, allFolders]
  )

  const value = useMemo<ActiveFolderContextValue>(
    () => ({ activeFolderId, activeFolder }),
    [activeFolderId, activeFolder]
  )

  return (
    <ActiveFolderContext.Provider value={value}>
      {children}
    </ActiveFolderContext.Provider>
  )
}
