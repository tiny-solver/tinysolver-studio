import { getContentPreview, readContentProject } from "@/lib/api"
import { openUrl } from "@/lib/platform"
import { getServerBaseUrl } from "@/lib/transport"
import type { ContentPreviewInfo } from "@/lib/types"

/** `outputs/game/index.html` → the directory that holds the game and the
 *  file inside it to open. */
export function splitEntry(entry: string): { dir: string; file: string } {
  const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "")
  const slash = normalized.lastIndexOf("/")
  return slash < 0
    ? { dir: ".", file: normalized }
    : { dir: normalized.slice(0, slash), file: normalized.slice(slash + 1) }
}

/**
 * Where the preview server answers for a registered project. Desktop: the
 * loopback listener; web: the API origin the transport already talks to
 * (which may differ from the page origin in dev).
 */
export function previewBase(info: ContentPreviewInfo): string {
  const origin = info.loopback ?? getServerBaseUrl()
  return `${origin}${info.path.replace(/\/+$/, "")}`
}

/**
 * Open a content project's game in the system browser (a new tab in web
 * mode) — the same URL the Studio pane's iframe loads, so it needs no build
 * and follows the files on disk. Resolves `false` when the manifest names no
 * engine entry, i.e. there is no game to open.
 */
export async function openGameInBrowser(root: string): Promise<boolean> {
  const manifest = await readContentProject(root)
  const entry = manifest?.engine?.entry
  if (!entry) return false
  const { dir, file } = splitEntry(entry)
  const info = await getContentPreview(root)
  await openUrl(`${previewBase(info)}/${dir}/${file}`)
  return true
}
