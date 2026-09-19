import {
  listContentScenes,
  readContentProject,
  readFileForEdit,
  writeWorkspaceFileBase64,
} from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import type { ContentProjectManifest, ContentScene } from "@/lib/types"
import {
  createStarterScene,
  fromLegacyProjectFile,
  parseScene,
  type SceneFile,
} from "./document"

/**
 * Studio persistence inside a content project folder.
 *
 * Scenes live at `<outputs>/game/content/<scene>.studio.json`; the engine
 * reads the same files, and so does any agent. Concurrency uses the
 * backend's etag: a save carries the etag it loaded, and the backend
 * refuses to overwrite a file that changed since — the same rule the file
 * editor tabs use.
 */

export interface StudioProjectTarget {
  /** Absolute project root: the workspace folder. */
  root: string
  /** Relative layer directories, from the manifest or the default layout. */
  outputsDir: string
  assetsDir: string
  /** Relative directory that holds the scene files. */
  contentDir: string
  /** Relative path of the game's entry html for the preview iframe. */
  entry: string
  /** `null` when the folder has no `codeg-project.json`. */
  manifest: ContentProjectManifest | null
}

export interface LoadedScene {
  scene: SceneFile
  etag: string
  /** True when the file was in the first prototype's format and was
   *  converted; the next save rewrites it in the current schema. */
  migrated: boolean
}

/** Resolve where Studio reads and writes for a workspace folder. */
export async function resolveProjectTarget(
  root: string
): Promise<StudioProjectTarget> {
  const manifest = await readContentProject(root).catch((err) => {
    console.warn("[studio] cannot read codeg-project.json:", err)
    return null
  })
  const outputsDir = manifest?.paths?.outputs ?? "outputs"
  const assetsDir = manifest?.paths?.assets ?? "assets"
  return {
    root,
    outputsDir,
    assetsDir,
    contentDir: `${outputsDir}/game/content`,
    entry: manifest?.engine?.entry ?? `${outputsDir}/game/index.html`,
    manifest,
  }
}

export function scenePath(
  target: StudioProjectTarget,
  sceneId: string
): string {
  return `${target.contentDir}/${sceneId}.studio.json`
}

/** Root-relative paths whose change should reload the preview iframe:
 *  anything under the game output or the assets layer. */
export function affectsPreview(
  target: StudioProjectTarget,
  rel: string
): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "")
  return (
    norm.startsWith(`${target.outputsDir}/game/`) ||
    norm.startsWith(`${target.assetsDir}/`)
  )
}

function isNotFound(err: unknown): boolean {
  return extractAppCommandError(err)?.code === "not_found"
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export async function listScenes(
  target: StudioProjectTarget
): Promise<ContentScene[]> {
  return listContentScenes(target.root)
}

/** `null` when the scene file does not exist. */
export async function loadScene(
  target: StudioProjectTarget,
  sceneId: string
): Promise<LoadedScene | null> {
  let file
  try {
    file = await readFileForEdit(target.root, scenePath(target, sceneId))
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
  const input = JSON.parse(file.content)
  const legacy = fromLegacyProjectFile(input)
  if (legacy)
    return {
      scene: { ...legacy, id: sceneId },
      etag: file.etag,
      migrated: true,
    }
  const scene = parseScene(input)
  if (scene.id !== sceneId) {
    // The file name is what the engine loads; keep the two in step rather
    // than trusting a stale inner id.
    scene.id = sceneId
  }
  return { scene, etag: file.etag, migrated: false }
}

export function serializeScene(scene: SceneFile): string {
  return JSON.stringify(parseScene(scene), null, 2) + "\n"
}

/**
 * Write the scene. `expectedEtag` is the etag from the last load or save;
 * `null` creates the file. Resolves to the new etag. Rejects without
 * writing when the file on disk no longer matches — the caller keeps its
 * in-memory edits.
 */
export async function saveScene(
  target: StudioProjectTarget,
  scene: SceneFile,
  expectedEtag: string | null
): Promise<string> {
  const result = await writeWorkspaceFileBase64(
    target.root,
    scenePath(target, scene.id),
    textToBase64(serializeScene(scene)),
    expectedEtag
  )
  return result.etag
}

/** Create `<id>.studio.json` from the starter scene. Fails if it exists. */
export async function createScene(
  target: StudioProjectTarget,
  sceneId: string,
  name = sceneId
): Promise<LoadedScene> {
  const existing = await peekSceneEtag(target, sceneId)
  if (existing !== null) throw new Error(`Scene already exists: ${sceneId}`)
  const scene = createStarterScene(sceneId, name)
  const etag = await saveScene(target, scene, null)
  return { scene, etag, migrated: false }
}

/** Current etag of the scene on disk, or `null` when absent. */
export async function peekSceneEtag(
  target: StudioProjectTarget,
  sceneId: string
): Promise<string | null> {
  try {
    return (await readFileForEdit(target.root, scenePath(target, sceneId))).etag
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}
