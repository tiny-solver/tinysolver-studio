import type { Editor, JSONContent } from "@tiptap/core"

import type { PromptInputBlock } from "@/lib/types"

import type { ReferenceAttrs } from "./types"

/**
 * Send serialization: turn the composer document into the prose + reference
 * portion of a `PromptInputBlock[]`. (Out-of-band image/resource attachments are
 * appended by the host's `buildDraft`; this function owns only the editor doc.)
 *
 * Per-refType rule — see the P3 design:
 * - **file** references carry a `file://` uri and become first-class
 *   `resource_link` blocks (agent-readable resources), matching the pre-existing
 *   `@`-file behavior exactly: they are removed from the prose and appended as
 *   trailing ResourceLinks in document order. The backend folds each back to a
 *   `[name](uri)` link (`user_blocks_from_prompt`) and the transcript renders it
 *   as a chip — identical to today.
 * - **session / commit** references (a `codeg://` uri the agent can't fetch) and
 *   **agent / skill** references (no uri) stay *inline* as text, rendered by the
 *   node's own `renderMarkdown` (see {@link "../reference-text".referenceToMarkdown}).
 *
 * Removing files from the prose (rather than splitting the text around them)
 * keeps each text run a single block — no mid-paragraph fragmentation, no
 * boundary-whitespace loss — so a sentence like "see <file> please" renders on
 * one line with the file as a chip, exactly as the plain-textarea input did.
 */
export function docToPromptBlocks(editor: Editor): PromptInputBlock[] {
  const doc = editor.getJSON()
  const files: ReferenceAttrs[] = []
  const stripped = stripFileReferences(doc, files)

  const blocks: PromptInputBlock[] = []
  const text = serializeMarkdown(editor, stripped).trim()
  if (text) blocks.push({ type: "text", text })
  for (const file of files) blocks.push(fileResourceLink(file))
  return blocks
}

/** A reference node that should become a `resource_link` block: a file reference
 *  carrying a `file://` uri. The uri scheme is checked (not just refType) because
 *  the reference node's parseHTML allow-list also permits `codeg:` uris, so a
 *  pasted/forged `file`-typed node could carry a non-fetchable `codeg://` uri —
 *  those must stay inline as text, never be lifted to an ACP ResourceLink. */
function isFileReference(node: JSONContent): boolean {
  return (
    node.type === "reference" &&
    node.attrs?.refType === "file" &&
    typeof node.attrs?.uri === "string" &&
    node.attrs.uri.toLowerCase().startsWith("file://")
  )
}

/**
 * Deep-clone `node`, dropping every file reference from the inline content and
 * collecting the originals into `files` in document order. Non-file references
 * are left intact so they serialize inline. Dropping (rather than replacing with
 * placeholder text) leaves the surrounding prose untouched; any incidental
 * double space collapses on render and is harmless to the agent.
 */
function stripFileReferences(
  node: JSONContent,
  files: ReferenceAttrs[]
): JSONContent {
  if (!node.content) return node
  const content: JSONContent[] = []
  for (const child of node.content) {
    if (isFileReference(child)) {
      files.push(child.attrs as ReferenceAttrs)
      continue
    }
    content.push(stripFileReferences(child, files))
  }
  return { ...node, content }
}

function fileResourceLink(attrs: ReferenceAttrs): PromptInputBlock {
  const uri = attrs.uri as string
  const name = attrs.label.trim() || fileBaseName(uri) || attrs.id || uri
  return {
    type: "resource_link",
    uri,
    name,
    mime_type: null,
    description: null,
  }
}

/** Best-effort basename of a `file://` uri, for a ResourceLink that lost its label. */
function fileBaseName(uri: string): string {
  const path = uri.replace(/^file:\/+/i, "")
  const last = path.split("/").filter(Boolean).pop() ?? ""
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** The Markdown manager is always present (the Markdown extension is always loaded). */
function serializeMarkdown(editor: Editor, doc: JSONContent): string {
  if (!editor.markdown) throw new Error("Markdown extension not loaded")
  return editor.markdown.serialize(doc)
}
