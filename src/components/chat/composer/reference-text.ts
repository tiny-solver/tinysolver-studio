import type { ReferenceAttrs } from "./types"

/** Collapse newline runs to a single space so a reference stays one inline token. */
function collapseNewlines(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ")
}

/**
 * Escape text emitted as raw inline Markdown (Tiptap inserts a custom
 * `renderMarkdown` result verbatim). Backslash-escapes every inline-significant
 * ASCII punctuation char so a crafted label cannot inject Markdown structure
 * (links `[]()`, autolinks `<>`, code spans `` ` ``, emphasis `* _`,
 * strikethrough `~`, or escapes `\`).
 */
function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_~[\]()<>]/g, "\\$&")
}

// GFM extended autolinks fire on bare URLs / `www.` / emails even when the
// structural punctuation above is escaped, so backslash-escaping is not enough
// for free-standing text (it is enough inside `[...]` link text, where GFM does
// not nest links). Detect those triggers and render such text as a code span,
// which never autolinks and reproduces the text literally.
const AUTOLINK_TRIGGER = /(?:https?|ftp|mailto):|www\.|@/i

/** Wrap text in a Markdown code span with a fence long enough to be literal. */
function toInlineCode(text: string): string {
  const runs = text.match(/`+/g)
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0
  const fence = "`".repeat(longest + 1)
  // Per CommonMark, a code span beginning/ending with a backtick or space needs
  // a padding space (which the renderer strips back off).
  const pad = /^[`\s]|[`\s]$/.test(text) ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Render free-standing inline text (agent label, no-URI fallback) safely:
 * code-span it when it could trigger a GFM autolink, otherwise escape the
 * inline-significant punctuation. Normal labels are unaffected.
 */
function inlineText(text: string): string {
  const flat = collapseNewlines(text)
  return AUTOLINK_TRIGGER.test(flat)
    ? toInlineCode(flat)
    : escapeMarkdownText(flat)
}

/**
 * Render a Markdown link destination safely. URIs containing spaces,
 * parentheses, angle brackets or backslashes (e.g. `file:///a/b (1).ts` or a
 * Windows `file:///C:\dir\`) are wrapped in `<…>` so a `)` or trailing `\`
 * can't terminate / escape the link early. Inside `<…>` CommonMark still
 * interprets backslash escapes, so `\`, `<` and `>` are all escaped; newlines
 * are stripped. Clean URLs stay bare.
 */
function escapeLinkDestination(uri: string): string {
  const cleaned = uri.replace(/[\r\n]+/g, "")
  return /[\s()<>\\]/.test(cleaned)
    ? `<${cleaned.replace(/[\\<>]/g, "\\$&")}>`
    : cleaned
}

/**
 * Canonical human-readable Markdown text for a reference. Used by the node's
 * `renderMarkdown` (so `editor.getMarkdown()` and Markdown drafts read well) and
 * reused by Phase 3 send serialization.
 *
 * References with a URI render as a Markdown link `[label](uri)` — matching how
 * the backend's `user_blocks_from_prompt` already folds ResourceLinks into
 * `[name](uri)`. Agents render as `@label`. Skills render as the `/id`
 * invocation token (the stable id, never the possibly-localized display label).
 * Every interpolated label/uri is escaped — and free-standing URL/email-like
 * text is code-spanned — so a crafted reference cannot inject Markdown
 * structure (a second link, an autolink, an image, emphasis, …) into the prompt.
 */
export function referenceToMarkdown(attrs: ReferenceAttrs): string {
  switch (attrs.refType) {
    case "agent":
      return `@${inlineText(attrs.label || attrs.id)}`
    case "skill": {
      // Invocation token: the stable id is what the agent executes. The label
      // (possibly localized / containing spaces) is never used; an empty id is
      // neutralized to nothing rather than emitting a broken `/command`.
      const token = collapseNewlines(attrs.id).trim()
      return token ? `/${token}` : ""
    }
    case "file":
    case "session":
    case "commit": {
      const text = collapseNewlines(attrs.label || attrs.id)
      return attrs.uri
        ? `[${escapeMarkdownText(text)}](${escapeLinkDestination(attrs.uri)})`
        : inlineText(text)
    }
    default:
      return inlineText(attrs.label || attrs.id)
  }
}
