/**
 * Pure keyboard-decision logic for the composer, extracted so the IME / code
 * block / list precedence can be unit-tested exhaustively without driving a
 * real ProseMirror view (jsdom can't emulate IME composition reliably).
 */

/** The subset of a keydown event the submit decision depends on. */
export interface SubmitKeyEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** Standard DOM flag: a composition (IME) is in flight. */
  isComposing: boolean
  /** Legacy 229 sentinel some IMEs report on the composition-confirming key. */
  keyCode: number
}

/** Editor context that overrides plain Enter-to-submit with structural Enter. */
export interface SubmitKeyContext {
  /** ProseMirror `view.composing` — composition in flight (second IME signal). */
  composing: boolean
  /** Caret is inside a code block → Enter inserts a newline. */
  inCodeBlock: boolean
  /** Caret is inside a list item → Enter creates/exits the list item. */
  inList: boolean
}

/**
 * Decide whether a keydown should trigger submit. Returns `true` only for a
 * plain Enter (no modifiers), while not composing, and not inside a code block
 * or list. In every other case the editor keeps its default behavior (newline /
 * list split / IME confirm).
 */
export function shouldSubmitOnEnter(
  event: SubmitKeyEvent,
  context: SubmitKeyContext
): boolean {
  if (event.key !== "Enter") return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false
  }
  // IME guard: never submit while a composition is in flight. The Enter that
  // confirms a CJK candidate reports isComposing / keyCode 229 / view.composing.
  if (event.isComposing || event.keyCode === 229 || context.composing) {
    return false
  }
  // Structural Enter inside code blocks and lists (per the composer design).
  if (context.inCodeBlock || context.inList) return false
  return true
}
