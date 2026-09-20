"use client"

import { useEffect, useSyncExternalStore } from "react"

import { readContentProject } from "@/lib/api"

/**
 * What a workspace folder is, as far as the chrome cares: a content project
 * that targets a game (Studio can open it), or a content project without one.
 * Plain folders are simply absent from the index.
 */
export type ContentFolderKind = "game" | "content"

const EMPTY: ReadonlyMap<string, ContentFolderKind> = new Map()

// One index for the whole window: the sidebar and the tab strip both mark
// content projects, and neither should read every manifest on its own. The
// map is replaced (never mutated) so `useSyncExternalStore` sees a new
// snapshot exactly when a folder's kind changed.
let snapshot: ReadonlyMap<string, ContentFolderKind> = EMPTY
const listeners = new Set<() => void>()
const inFlight = new Set<string>()

function setKind(path: string, kind: ContentFolderKind | null) {
  if ((snapshot.get(path) ?? null) === kind) return
  const next = new Map(snapshot)
  if (kind) next.set(path, kind)
  else next.delete(path)
  snapshot = next
  for (const listener of listeners) listener()
}

function load(path: string) {
  if (inFlight.has(path)) return
  inFlight.add(path)
  // Deferred into the chain so a synchronous throw lands in the catch too. A
  // manifest that can't be read is reported as "not a project" — the marker
  // is a hint, and a folder the tooling can't trust should not carry it.
  Promise.resolve()
    .then(() => readContentProject(path))
    .then((manifest) =>
      setKind(
        path,
        manifest
          ? manifest.outputs.includes("game")
            ? "game"
            : "content"
          : null
      )
    )
    .catch(() => setKind(path, null))
    .finally(() => inFlight.delete(path))
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => snapshot
const getServerSnapshot = () => EMPTY

/**
 * Which of `paths` are content projects, keyed by path. Reads each folder's
 * `codeg-project.json` when the set of paths changes and again on window
 * focus — an agent (or the launcher in another window) may have scaffolded a
 * project since.
 */
export function useContentProjectIndex(
  paths: readonly string[]
): ReadonlyMap<string, ContentFolderKind> {
  const key = paths.join("\n")
  useEffect(() => {
    if (!key) return
    const all = key.split("\n")
    const refresh = () => all.forEach(load)
    refresh()
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [key])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
