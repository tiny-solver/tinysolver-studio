"use client"

import { useEffect, useState } from "react"

import { readContentProject } from "@/lib/api"
import type { ContentProjectManifest } from "@/lib/types"

interface Loaded {
  path: string
  manifest: ContentProjectManifest | null
}

/**
 * The `codeg-project.json` of a folder, or `null` when it is not a content
 * project (or none is open). Re-reads on every path change and on window
 * focus, since an agent may write the manifest while a conversation runs.
 * Read failures (a corrupt manifest, a newer schema) are logged and reported
 * as `null` — the welcome tab then shows the "not a project" hint, which is
 * the right fallback for a folder the tooling can't trust.
 *
 * The result is keyed by the path it was loaded for, so switching folders
 * drops the previous manifest on the same render instead of flashing it
 * until the new read resolves.
 */
export function useContentProject(
  path: string | null | undefined
): ContentProjectManifest | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    const load = () => {
      readContentProject(path)
        .then((manifest) => {
          if (!cancelled) setLoaded({ path, manifest })
        })
        .catch((err) => {
          console.warn("[useContentProject] failed to read manifest:", err)
          if (!cancelled) setLoaded({ path, manifest: null })
        })
    }
    load()
    window.addEventListener("focus", load)
    return () => {
      cancelled = true
      window.removeEventListener("focus", load)
    }
  }, [path])

  return path && loaded?.path === path ? loaded.manifest : null
}
