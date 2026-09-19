"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { StudioWorkspace } from "@/components/studio/studio-workspace"

// `?path=<workspace folder>` selects project-folder persistence. Reading
// search params needs a Suspense boundary under static export.
function StudioPageInner() {
  const projectRoot = useSearchParams().get("path")
  return <StudioWorkspace projectRoot={projectRoot} />
}

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioPageInner />
    </Suspense>
  )
}
