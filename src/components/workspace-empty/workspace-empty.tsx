"use client"

import { useEffect, useState, useCallback } from "react"
import { loadFolderHistory } from "@/lib/api"
import type { FolderHistoryEntry } from "@/lib/types"
import { FolderActions } from "./folder-actions"
import { FolderList } from "./folder-list"
import { SoftwareInfo } from "./software-info"

export function WorkspaceEmpty() {
  const [history, setHistory] = useState<FolderHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await loadFolderHistory()
      setHistory(result)
    } catch (err) {
      console.error("[WorkspaceEmpty] loadFolderHistory failed:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <SoftwareInfo />
        <FolderActions />
      </aside>
      <main className="flex-1 min-w-0">
        <FolderList history={history} loading={loading} onRefresh={refresh} />
      </main>
    </div>
  )
}
