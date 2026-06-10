import type { Extensions } from "@tiptap/core"
import { Markdown } from "@tiptap/markdown"
import { Placeholder } from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"

import { Reference } from "./nodes/reference-node"

/**
 * Options for the shared composer extension set. The `@`/`/` suggestion
 * extensions are layered on in Phase 2 via additional entries to
 * {@link buildComposerExtensions}.
 */
export interface ComposerExtensionOptions {
  /** Placeholder shown when the document is empty. */
  placeholder?: string
}

/**
 * Build the Tiptap extension set powering the rich-text composer.
 *
 * Shared by the live editor ({@link "./rich-composer".RichComposer}) and the
 * headless editor used in tests, so the Markdown round-trip exercised by tests
 * matches what users actually type.
 *
 * StarterKit (v3) already bundles paragraph/heading/lists/bold/italic/strike/
 * code/codeBlock/blockquote/link/history/hardBreak and the relevant input
 * rules, which gives us live WYSIWYG Markdown. `Markdown` adds
 * `editor.getMarkdown()` / `editor.markdown.parse()` for serialization.
 */
export function buildComposerExtensions(
  options: ComposerExtensionOptions = {}
): Extensions {
  return [
    StarterKit,
    Placeholder.configure({
      placeholder: options.placeholder ?? "",
      // Only paint the placeholder while the editor is editable so a disabled
      // composer reads as empty rather than as a hint.
      showOnlyWhenEditable: true,
    }),
    Markdown,
    Reference,
  ]
}
