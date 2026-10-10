"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { StudioFilmSet } from "@/components/studio/studio-film-set"
import { StudioWorkspace } from "@/components/studio/studio-workspace"

// `?path=<workspace folder>` selects project-folder persistence;
// `&view=set` opens that project's 3D film sets instead of the scene editor.
// Reading search params needs a Suspense boundary under static export.
function StudioPageInner() {
  const params = useSearchParams()
  const projectRoot = params.get("path")
  if (projectRoot && params.get("view") === "set")
    return (
      <div className="h-screen">
        <StudioFilmSet projectRoot={projectRoot} />
      </div>
    )
  return <StudioWorkspace projectRoot={projectRoot} />
}

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <StudioPageInner />
    </Suspense>
  )
}
