"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"

import { StudioFlows } from "@/components/studio/studio-flows"
import { listProjects } from "@/lib/studio/flows"

// `?path=<project>&flow=<id>&run=<run>&b=<other run>` — query parameters,
// not route segments (static export). Without `path` the server's default
// content project is used (server mode).
function StudioFlowsPageInner() {
  const params = useSearchParams()
  const router = useRouter()
  const [fallback, setFallback] = useState<string | null>(null)
  const [looked, setLooked] = useState(false)
  const path = params.get("path")

  useEffect(() => {
    if (path) return
    void listProjects().then((p) => {
      setFallback(p?.default ?? p?.projects[0]?.path ?? null)
      setLooked(true)
    })
  }, [path])

  const root = path ?? fallback
  const navigate = useCallback(
    (next: {
      flow?: string | null
      run?: string | null
      b?: string | null
    }) => {
      const q = new URLSearchParams(params.toString())
      if (root && !q.get("path")) q.set("path", root)
      for (const [k, v] of Object.entries(next)) {
        if (v) q.set(k, v)
        else q.delete(k)
      }
      router.push(`?${q.toString()}`)
    },
    [params, root, router]
  )

  if (!root)
    return looked ? (
      <p className="p-6 text-sm text-muted-foreground">
        ?path=&lt;content project folder&gt;
      </p>
    ) : null
  return (
    <div className="h-screen">
      <StudioFlows
        root={root}
        flow={params.get("flow")}
        run={params.get("run")}
        compareTo={params.get("b")}
        onNavigate={navigate}
      />
    </div>
  )
}

export default function StudioFlowsPage() {
  return (
    <Suspense fallback={null}>
      <StudioFlowsPageInner />
    </Suspense>
  )
}
