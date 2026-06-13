/**
 * A conversation's auto-title is parsed from the first user message, which since
 * the inline-file-badge work can carry Markdown reference links — a `@`-file
 * mention, a session/commit/agent reference — serialized as `[label](uri)` (see
 * `referenceToMarkdown`). Shown verbatim in a tab or the sidebar that reads as
 * raw `[README.md](file:///…)` noise. {@link formatConversationTitle} folds each
 * such link back to just its bracket label (the human-readable badge text),
 * leaving all other title text untouched, so titles display the way the message
 * does. Display-only — the stored title (rename, search, export) is unchanged.
 *
 * Implemented as a single forward scan rather than a regex: titles are not
 * length-capped on the rename/API paths, and a regex for `[label](dest)` with
 * its escaped-label / `<…>`-dest branches backtracks super-linearly on
 * pathological input (e.g. thousands of unmatched `[`), which would jank every
 * sidebar/tab render. This parser visits each character O(1) times.
 */

// Reverse `escapeMarkdownText`: drop the backslash from each escaped
// inline-significant punctuation char so the recovered label reads literally.
function unescapeLabel(label: string): string {
  return label.replace(/\\([\\`*_~[\]()<>])/g, "$1")
}

// Whether the backslash at `k` escapes the next character. CommonMark never lets
// a backslash escape a space or line break, so a `\` + whitespace must END (not
// extend) a label/destination scan — only `\` + a non-whitespace char (the
// punctuation we care about: `]`, `>`, `<`, `)`) is a real escape. This keeps a
// malformed `[a](foo\ bar)` or `[a](<…\<newline>…>)` correctly left verbatim.
function escapesNext(s: string, k: number): boolean {
  return s[k] === "\\" && k + 1 < s.length && !/\s/.test(s[k + 1])
}

/**
 * If a well-formed `(destination)` begins at `start`, return the index just past
 * its closing `)`; otherwise -1. Mirrors `escapeLinkDestination`'s two forms: an
 * `<…>`-wrapped destination (interior `\`, `<`, `>` backslash-escaped) or a bare
 * run containing no `(`, `)`, whitespace, `<` or `>`.
 */
function destinationEnd(s: string, start: number): number {
  const n = s.length
  if (start >= n || s[start] !== "(") return -1
  let k = start + 1
  if (s[k] === "<") {
    k += 1
    while (k < n) {
      const c = s[k]
      if (escapesNext(s, k)) {
        k += 2
        continue
      }
      if (c === ">") return s[k + 1] === ")" ? k + 2 : -1
      // CommonMark forbids an unescaped `<` or a line break inside `<…>`, so
      // bail on them. This also bounds the scan: a malformed `…](<…` without a
      // closing `>` stops at the next `<` instead of running to EOF, which is
      // what keeps `"[a](<".repeat(n)` linear rather than quadratic.
      if (c === "<" || c === "\n" || c === "\r") return -1
      k += 1
    }
    return -1
  }
  while (k < n) {
    const c = s[k]
    if (escapesNext(s, k)) {
      k += 2
      continue
    }
    if (c === ")") return k + 1
    if (c === "(" || c === "<" || c === ">" || /\s/.test(c)) return -1
    k += 1
  }
  return -1
}

/**
 * Replace every `[label](destination)` link in a conversation title with its
 * unescaped `label`, so inline badges display as their text instead of raw
 * Markdown. Plain prose (including invocation tokens like `@Codex` or `/review`,
 * which are not links) is left as-is, as are malformed `[…]`/`(…)` fragments. A
 * raw `[text](url)` never belongs in a one-line title, so ordinary links are
 * folded too. Returns `""` for a nullish title so callers can keep their
 * `formatConversationTitle(title) || untitledFallback` shape.
 */
export function formatConversationTitle(
  title: string | null | undefined
): string {
  if (!title) return ""
  const n = title.length
  let out = ""
  let i = 0
  while (i < n) {
    if (title[i] !== "[") {
      out += title[i]
      i += 1
      continue
    }
    // Scan the label to the `]` that balances this `[`, skipping escaped pairs
    // and tracking nested unescaped brackets so a balanced label closes at the
    // right `]` (`[a [b]](u)` folds to `a [b]`, not the inner `[b]`), while an
    // unbalanced `[a [b](u)` never closes and is left verbatim. Reference labels
    // escape their brackets, so depth only matters for hand-typed nested prose;
    // we deliberately don't replicate CommonMark's full nested-link resolution
    // (which needs backtracking) — that would forfeit the single-pass O(n) scan.
    let j = i + 1
    let depth = 0
    let closed = false
    while (j < n) {
      const c = title[j]
      if (escapesNext(title, j)) {
        j += 2
        continue
      }
      if (c === "[") {
        depth += 1
        j += 1
        continue
      }
      if (c === "]") {
        if (depth === 0) {
          closed = true
          break
        }
        depth -= 1
        j += 1
        continue
      }
      j += 1
    }
    if (!closed) {
      // No `]` remains ahead, so nothing else can be a link either.
      out += title.slice(i)
      break
    }
    const end = destinationEnd(title, j + 1)
    if (end === -1) {
      // `[…]` not followed by a well-formed `(dest)`: emit it literally and
      // resume just after `]` — never re-scanning the label, which keeps the
      // whole pass O(n) even on adversarial unmatched-bracket input.
      out += title.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += unescapeLabel(title.slice(i + 1, j))
    i = end
  }
  return out
}
