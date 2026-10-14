"use client"

import { Suspense, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { StudioLibrary } from "@/components/studio/studio-library"

// `?sel=<project>:<id>,…&view=compare` · `?item=<project>:<id>` — query
// parameters, not route segments (static export). Server mode reads every
// project under the server's projects folder; elsewhere `?path=` names one.
function StudioLibraryPageInner() {
  const params = useSearchParams()
  const router = useRouter()
  const selected = (params.get("sel") ?? "").split(",").filter(Boolean)

  const navigate = useCallback(
    (next: {
      sel?: string[]
      item?: string | null
      view?: "compare" | null
    }) => {
      const q = new URLSearchParams(params.toString())
      const set = (k: string, v: string | null | undefined) =>
        v ? q.set(k, v) : q.delete(k)
      if (next.sel) set("sel", next.sel.join(","))
      if ("item" in next) set("item", next.item)
      if ("view" in next) set("view", next.view)
      router.push(`?${q.toString()}`)
    },
    [params, router]
  )

  return (
    <div className="h-screen overflow-auto">
      <StudioLibrary
        fallbackRoot={params.get("path")}
        selected={selected}
        item={params.get("item")}
        comparing={params.get("view") === "compare"}
        onNavigate={navigate}
      />
    </div>
  )
}

export default function StudioLibraryPage() {
  return (
    <Suspense fallback={null}>
      <StudioLibraryPageInner />
    </Suspense>
  )
}
