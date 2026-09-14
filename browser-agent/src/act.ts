/**
 * Acting on an element an agent named in a snapshot — the other half of
 * `__codegAgent`, and the reason refs exist at all.
 *
 * Everything here is JavaScript dispatching events at the element, which the
 * host reports as `synthetic` fidelity. A page cannot tell these apart from a
 * script of its own doing the same thing (`isTrusted` is false on all of
 * them), and there are things a synthetic event does not do that a real one
 * would: open a popup, enter fullscreen, apply `:hover`, move focus on
 * mousedown, submit a form on Enter. Where the engine's default action is the
 * whole point of the key — Enter in a form, Space on a button, Tab — this
 * emulates it, because an agent that pressed Enter meant the form to go.
 * Where it is not emulable (a popup needs user activation) the fidelity field
 * on the result is how the agent finds out.
 *
 * On a platform with a trusted-input channel the host does the pointing
 * itself: `pointAt` and `obstructionAt` still decide *where*, and the
 * platform delivers a real mouse there.
 *
 * Nothing here resolves a ref. `index.ts` does that, under the staleness
 * rules that live with the snapshot, and hands an element in.
 */

export type PointerButton = "left" | "right"

/** What an agent may do to an element. `press` alone may go without a ref
 *  (to whatever has focus); the rest name one. */
export type ActionRequest =
  | { kind: "click"; button?: PointerButton; count?: number }
  | { kind: "hover" }
  /** Replaces the field's value — the predictable meaning, and the one that
   *  does not depend on what was there. */
  | { kind: "type"; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "select"; values: string[] }

export type ActionError =
  /** The ref no longer names anything: another document, a moved page, a
   *  removed element. Take a new snapshot. */
  | "stale"
  /** The element has no box on screen even after scrolling to it. */
  | "not-visible"
  /** Another element is on top at the point a pointer would land. A user
   *  could not click this either; a dialog's backdrop is the common case. */
  | "obscured"
  /** `type` on something that takes no text, `select` on no `<select>`. */
  | "not-editable"
  /** `select`: a value matched no option. The detail lists them. */
  | "no-option"
  /** The control is disabled: a person could not operate it either, and a
   *  dispatched event would reach its handlers anyway. */
  | "disabled"
  /** Not a request this world understands. */
  | "unsupported"

export type ActionFailure = { error: ActionError; detail: string }

/** A point in viewport CSS pixels, which is what both a dispatched event and
 *  CDP's `Input.dispatchMouseEvent` take. */
export type Point = { x: number; y: number }

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

/**
 * Bring the element into view and find the point a pointer would touch it.
 *
 * The centre of its largest visible box. Largest rather than bounding: an
 * inline element that wraps has a bounding box whose centre can be empty
 * space between its two lines. Clipped to the viewport before taking the
 * centre, so an element half under the fold is hit in the half that shows.
 */
export function pointAt(el: Element): Point | ActionFailure {
  // `center` rather than `nearest`: `nearest` leaves an element that is just
  // below the fold flush against the bottom edge, under whatever fixed
  // footer the page keeps there. `instant` so the rect read next is the one
  // the page will be at, not a frame of a smooth scroll.
  el.scrollIntoView?.({
    block: "center",
    inline: "center",
    behavior: "instant" as ScrollBehavior,
  })
  const box = visibleBox(el)
  if (!box)
    return {
      error: "not-visible",
      detail: `${describe(el)} has no visible box on screen`,
    }
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

function visibleBox(el: Element): DOMRect | null {
  const rects = Array.from(el.getClientRects())
  const box = rects.length
    ? rects.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
    : el.getBoundingClientRect()
  const left = Math.max(box.left, 0)
  const top = Math.max(box.top, 0)
  const right = Math.min(box.right, window.innerWidth)
  const bottom = Math.min(box.bottom, window.innerHeight)
  if (right - left < 1 || bottom - top < 1) return null
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * Whatever is on top of `target` at `(x, y)`, or `null` when the target
 * itself (or something inside it) is what a pointer there would touch.
 *
 * Looks *through* shadow roots on the way down and *up* through shadow hosts
 * on the way back: a button rendered by a web component is inside the
 * component's shadow tree, and the element the agent named may be either.
 */
export function obstructionAt(
  x: number,
  y: number,
  target: Element
): Element | null {
  const hit = deepElementFromPoint(x, y)
  if (!hit) return document.documentElement
  for (let node: Node | null = hit; node; node = parentOf(node)) {
    if (node === target) return null
  }
  return hit
}

function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y)
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

function parentOf(node: Node): Node | null {
  const parent = node.parentNode
  return parent instanceof ShadowRoot ? parent.host : parent
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

// jsdom has no `PointerEvent`; the tests that run there exercise the mouse
// half of the sequence and a real engine gets both.
const PointerCtor: typeof MouseEvent =
  typeof PointerEvent === "function" ? PointerEvent : MouseEvent

/**
 * The event sequence a click is made of, delivered to the element.
 *
 * Pointer events as well as mouse events: a component library that opens on
 * `pointerdown` (Radix, Headless UI) never sees a bare `click`. Focus is
 * moved by hand after `mousedown`, since that is the engine's default action
 * for a real one and a dispatched one has no default action at all — but only
 * when nobody cancelled it, which is the same rule the engine applies.
 */
export function clickAt(
  el: Element,
  point: Point,
  button: PointerButton,
  count: number,
  stillCurrent: () => boolean = () => true
): number {
  const buttonCode = button === "right" ? 2 : 0
  const held = button === "right" ? 2 : 1
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
    button: buttonCode,
  }
  const pointer = (type: string, init: PointerEventInit = {}) =>
    el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init,
      } as PointerEventInit)
    )
  const mouse = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent(type, { ...base, ...init }))

  enter(el, point)
  let delivered = 0
  for (let i = 1; i <= count; i++) {
    // The first click may have changed the page — a link to a fragment, a
    // button that re-renders — and the second is owed to the element as it
    // was named, not to whatever it is now.
    if (i > 1 && !stillCurrent()) break
    const downOk = pointer("pointerdown", { detail: i, buttons: held })
    // Cancelling `pointerdown` suppresses the compatibility mouse events
    // (`mousedown`, `mouseup`) and with them the focus change, and leaves
    // `click`: that is the Pointer Events rule, and a handler that cancels
    // pointerdown to keep focus where it is relies on it.
    if (downOk) {
      const mouseDownOk = mouse("mousedown", { detail: i, buttons: held })
      if (mouseDownOk) focusFrom(el)
    }
    pointer("pointerup", { detail: i, buttons: 0 })
    if (downOk) mouse("mouseup", { detail: i, buttons: 0 })
    // A dispatched `click` still runs the element's activation behaviour —
    // a link follows its href, a submit button submits, a checkbox toggles —
    // which is what makes this a click and not a notification of one.
    if (button === "right") mouse("contextmenu", { detail: i })
    else mouse("click", { detail: i })
    delivered = i
  }
  // Only for a run that completed: a run stopped short because the page
  // moved has no business sending one more event to the element as it was.
  if (button === "left" && count >= 2 && delivered === count)
    mouse("dblclick", { detail: delivered })
  return delivered
}

/** A form control a person could not operate: `disabled` on itself or
 *  through a disabled `<fieldset>`. */
export function isDisabledControl(el: Element): boolean {
  try {
    return el.matches(":disabled")
  } catch {
    return (el as HTMLButtonElement).disabled === true
  }
}

/** Laid out and not hidden — what a retarget from a label or a wrapper may
 *  land on. A person cannot type into a control that is not on the page.
 *
 *  `checkVisibility` where the engine has it (it answers for the ancestors
 *  too); otherwise the ancestors are walked, because a control under a
 *  `display: none` parent reports its own display as whatever it was set
 *  to, not as none. */
function isRendered(el: Element): boolean {
  const check = (
    el as Element & {
      checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean
    }
  ).checkVisibility
  if (typeof check === "function")
    return check.call(el, { visibilityProperty: true })
  if (getComputedStyle(el).visibility === "hidden") return false
  for (let node: Element | null = el; node; node = parentElementOf(node)) {
    const style = getComputedStyle(node) as CSSStyleDeclaration & {
      contentVisibility?: string
    }
    if (style.display === "none" || style.contentVisibility === "hidden")
      return false
  }
  return true
}

/** Just the arrival: what a pointer does when it comes to rest over `el`. */
export function hoverAt(el: Element, point: Point): void {
  enter(el, point)
}

function enter(el: Element, point: Point): void {
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    screenX: point.x,
    screenY: point.y,
  }
  const pointer = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init,
      } as PointerEventInit)
    )
  const mouse = (type: string, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent(type, { ...base, ...init }))
  pointer("pointerover")
  pointer("pointerenter", { bubbles: false })
  mouse("mouseover")
  mouse("mouseenter", { bubbles: false })
  pointer("pointermove")
  mouse("mousemove")
}

/** Focus the nearest focusable ancestor-or-self, or blur whatever has focus
 *  when there is none — both being what a real mousedown does. */
function focusFrom(el: Element): void {
  for (let node: Element | null = el; node; node = parentElementOf(node)) {
    if (node instanceof HTMLElement && isFocusable(node)) {
      node.focus({ preventScroll: true })
      return
    }
  }
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

function parentElementOf(el: Element): Element | null {
  const parent = el.parentNode
  if (parent instanceof ShadowRoot) return parent.host
  return parent instanceof Element ? parent : null
}

function isFocusable(el: HTMLElement): boolean {
  // `tabIndex` is 0 for form controls and links with an href and -1 for the
  // rest, except that an explicit `tabindex="-1"` still takes focus from a
  // click — it only leaves the tab order.
  return el.tabIndex >= 0 || el.hasAttribute("tabindex") || el.isContentEditable
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TextControl = HTMLInputElement | HTMLTextAreaElement

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "file",
  "image",
  "hidden",
])

function isTextControl(el: Element): el is TextControl {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type)
}

/** The thing that takes text, starting from what the agent named: the field
 *  itself, the control a label is for, the editing host around a
 *  contenteditable node, or a field inside a wrapper the tree named instead. */
function editableFrom(el: Element): TextControl | HTMLElement | null {
  if (isTextControl(el)) return el
  // Leaving the named element for another is allowed only towards a control
  // a person could reach from it: one that is on the page.
  const reachable = (candidate: Element | null | undefined) =>
    candidate && isTextControl(candidate) && isRendered(candidate)
      ? candidate
      : null
  if (el instanceof HTMLLabelElement) return reachable(el.control)
  if (el instanceof HTMLElement && el.isContentEditable) {
    let host: HTMLElement = el
    while (
      host.parentElement instanceof HTMLElement &&
      host.parentElement.isContentEditable
    )
      host = host.parentElement
    return host
  }
  return reachable(el.querySelector("input:not([type=hidden]), textarea"))
}

/**
 * Replace the field's value with `text`, the way a person selecting all and
 * typing would.
 *
 * `execCommand("insertText")` first: it goes through the engine's own editing
 * path, so the `beforeinput` / `input` events it fires are the ones the page
 * would get from a keyboard. It is not implemented for every input type (a
 * `number` field has no selection to replace), so when it declines, or the
 * value did not end up as asked, the value is set directly through the
 * prototype's setter and an `input` event is dispatched by hand. A framework
 * that tracks the value on the instance (React) sees the change either way:
 * this world's prototype setter is the native one, and an expando the page
 * put on the node is not visible from here.
 */
export function typeInto(el: Element, text: string): ActionFailure | null {
  const target = editableFrom(el)
  if (!target)
    return { error: "not-editable", detail: `${describe(el)} takes no text` }
  if (isTextControl(target)) {
    // `:disabled`, not the own flag: a disabled `<fieldset>` disables the
    // fields in it without setting anything on them.
    if (isDisabledControl(target))
      return {
        error: "disabled",
        detail: `${describe(target)} is disabled`,
      }
    if (target.readOnly)
      return {
        error: "not-editable",
        detail: `${describe(target)} is read-only`,
      }
    target.focus({ preventScroll: true })
    replaceValue(target, text)
    return null
  }
  target.focus({ preventScroll: true })
  replaceContents(target, text)
  return null
}

function replaceValue(input: TextControl, text: string): void {
  let done = false
  try {
    input.select()
    done =
      text === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, text)
  } catch {
    done = false
  }
  if (!done || input.value !== text) {
    setNativeValue(input, text)
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      })
    )
  }
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

function setNativeValue(el: TextControl, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

function replaceContents(host: HTMLElement, text: string): void {
  const selection = window.getSelection()
  if (selection) {
    const range = document.createRange()
    range.selectNodeContents(host)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  let done = false
  try {
    done =
      text === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, text)
  } catch {
    done = false
  }
  if (!done) {
    host.textContent = text
    host.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null,
      })
    )
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type KeyDescription = {
  key: string
  code: string
  keyCode: number
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** A single character, which a keypress would insert. */
  printable: boolean
}

const NAMED_KEYS: Record<
  string,
  { code: string; keyCode: number; key?: string }
> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, key: " " },
}
for (let n = 1; n <= 12; n++)
  NAMED_KEYS[`F${n}`] = { code: `F${n}`, keyCode: 111 + n }

const KEY_ALIASES: Record<string, string> = {
  Return: "Enter",
  Esc: "Escape",
  Del: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  " ": "Space",
  Spacebar: "Space",
}

const MODIFIER_ALIASES: Record<
  string,
  keyof Pick<KeyDescription, "ctrl" | "shift" | "alt" | "meta">
> = {
  Control: "ctrl",
  Ctrl: "ctrl",
  Shift: "shift",
  Alt: "alt",
  Option: "alt",
  Meta: "meta",
  Cmd: "meta",
  Command: "meta",
  Super: "meta",
}

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
}

/**
 * `"Enter"`, `"a"`, `"Control+Shift+k"`, `"Meta+Enter"` → what to put on the
 * `KeyboardEvent`. `null` for a name this table does not know: an agent
 * asking for `"Foo"` should hear so, not have a key called Foo dispatched.
 *
 * `code` and `keyCode` are best effort from a US layout — handlers overwhelmingly
 * read `key`, and those two are filled in for the ones that read the others.
 */
export function keyDescription(spec: string): KeyDescription | null {
  const parts = spec.split("+")
  // A literal "+" ("Shift++") splits into empty parts; put one back.
  const last = parts.pop() ?? ""
  let name = last === "" && spec.endsWith("+") ? "+" : last
  const mods = { ctrl: false, shift: false, alt: false, meta: false }
  for (const part of parts) {
    if (part === "") continue
    const mod = MODIFIER_ALIASES[part]
    if (!mod) return null
    mods[mod] = true
  }
  name = KEY_ALIASES[name] ?? name
  if (name.length === 1) {
    const upper = name.toUpperCase()
    let code = ""
    let keyCode = 0
    if (/[A-Z]/.test(upper)) {
      code = `Key${upper}`
      keyCode = upper.charCodeAt(0)
    } else if (/[0-9]/.test(name)) {
      code = `Digit${name}`
      keyCode = name.charCodeAt(0)
    } else if (PUNCTUATION[name]) {
      ;({ code, keyCode } = PUNCTUATION[name])
    }
    return { key: name, code, keyCode, ...mods, printable: true }
  }
  const named = NAMED_KEYS[name]
  if (!named) return null
  return {
    key: named.key ?? name,
    code: named.code,
    keyCode: named.keyCode,
    ...mods,
    printable: false,
  }
}

/**
 * Press `key` on `el`, or on whatever has focus when `el` is `null`.
 *
 * `keydown`, then — unless a handler cancelled it — what the engine would do
 * with the key, then `keyup`. The default actions emulated are the ones an
 * agent presses a key *for*: Enter submits the form a text field is in (via
 * its default button, so the button's own handler runs) or activates a button
 * or link; Space activates a button; Tab moves focus; Backspace and Delete
 * edit; a printable key types. Arrow keys and Escape dispatch and do nothing
 * further, which is what they do on most pages, whose handlers act on
 * `keydown`.
 */
export function pressOn(
  el: Element | null,
  spec: string
): ActionFailure | null {
  const desc = keyDescription(spec)
  if (!desc)
    return {
      error: "unsupported",
      detail: `"${spec}" is not a key this browser knows`,
    }
  if (el && isDisabledControl(el))
    return { error: "disabled", detail: `${describe(el)} is disabled` }
  if (el instanceof HTMLElement && deepActiveElement() !== el)
    el.focus({ preventScroll: true })
  const target = el ?? deepActiveElement() ?? document.body
  if (!target)
    return { error: "not-visible", detail: "the page has no body yet" }
  const init: KeyboardEventInit = {
    key: desc.key,
    code: desc.code,
    keyCode: desc.keyCode,
    which: desc.keyCode,
    ctrlKey: desc.ctrl,
    shiftKey: desc.shift,
    altKey: desc.alt,
    metaKey: desc.meta,
    bubbles: true,
    cancelable: true,
    composed: true,
  } as KeyboardEventInit
  const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init))
  if (proceed) {
    const plain = !desc.ctrl && !desc.alt && !desc.meta
    if (desc.printable && plain) {
      if (
        target.dispatchEvent(
          new KeyboardEvent("keypress", {
            ...init,
            charCode: desc.key.charCodeAt(0),
          } as KeyboardEventInit)
        )
      )
        insertTyped(target, desc.key)
    } else {
      defaultActionFor(target, desc)
    }
  }
  target.dispatchEvent(
    new KeyboardEvent("keyup", { ...init, cancelable: false })
  )
  return null
}

function deepActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement
  return active
}

function insertTyped(target: Element, char: string): void {
  const editable = editableFrom(target)
  if (!editable) return
  if (
    isTextControl(editable) &&
    (isDisabledControl(editable) || editable.readOnly)
  )
    return
  let done = false
  try {
    done = document.execCommand("insertText", false, char)
  } catch {
    done = false
  }
  if (done) return
  if (isTextControl(editable)) {
    const start = editable.selectionStart ?? editable.value.length
    const end = editable.selectionEnd ?? editable.value.length
    setNativeValue(
      editable,
      editable.value.slice(0, start) + char + editable.value.slice(end)
    )
    try {
      editable.setSelectionRange(start + char.length, start + char.length)
    } catch {
      /* not every input type has a selection */
    }
  } else {
    editable.textContent = (editable.textContent ?? "") + char
  }
  editable.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: char,
    })
  )
}

function defaultActionFor(target: Element, desc: KeyDescription): void {
  const plain = !desc.ctrl && !desc.alt && !desc.meta
  switch (desc.key) {
    case "Enter": {
      // Alt+Enter is not a submission anywhere; Ctrl/Meta+Enter is the usual
      // "send" chord and is treated like a plain Enter on a field.
      if (desc.alt) return
      if (target instanceof HTMLTextAreaElement && plain) {
        insertTyped(target, "\n")
        return
      }
      if (target instanceof HTMLElement && target.isContentEditable && plain) {
        try {
          document.execCommand("insertParagraph")
        } catch {
          /* leave it */
        }
        return
      }
      if (target instanceof HTMLInputElement && isTextControl(target)) {
        submitImplicitly(target)
        return
      }
      if (isActivatable(target)) (target as HTMLElement).click()
      return
    }
    case " ": {
      if (!plain) return
      if (target instanceof HTMLButtonElement || isCheckable(target)) {
        target.click()
        return
      }
      insertTyped(target, " ")
      return
    }
    case "Tab": {
      if (desc.ctrl || desc.alt || desc.meta) return
      moveFocus(target, desc.shift ? -1 : 1)
      return
    }
    case "Backspace":
    case "Delete": {
      if (!plain) return
      const editable = editableFrom(target)
      if (!editable) return
      try {
        document.execCommand(
          desc.key === "Backspace" ? "delete" : "forwardDelete"
        )
      } catch {
        /* leave it */
      }
      return
    }
    default:
      return
  }
}

function isActivatable(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return true
  if (el instanceof HTMLAnchorElement) return el.hasAttribute("href")
  if (el instanceof HTMLInputElement)
    return (
      el.type === "submit" ||
      el.type === "button" ||
      el.type === "reset" ||
      el.type === "image"
    )
  return false
}

function isCheckable(el: Element): el is HTMLInputElement {
  return (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  )
}

/**
 * Implicit submission, as the spec has it: click the form's default button if
 * it has one (so the button's own handler and its name/value take part);
 * otherwise submit only if there is a single field that blocks implicit
 * submission — a form with two text fields and no button does not go on
 * Enter, and neither should this.
 */
function submitImplicitly(input: HTMLInputElement): void {
  const form = input.form
  if (!form || isDisabledControl(input)) return
  const elements = Array.from(form.elements)
  const button = elements.find(
    (el) =>
      (el instanceof HTMLButtonElement && el.type === "submit") ||
      (el instanceof HTMLInputElement &&
        (el.type === "submit" || el.type === "image"))
  )
  if (button instanceof HTMLElement) {
    if (!(button as HTMLButtonElement).disabled) button.click()
    return
  }
  const blocking = elements.filter(
    (el) =>
      el instanceof HTMLInputElement &&
      isTextControl(el) &&
      el.type !== "hidden"
  )
  if (blocking.length > 1) return
  if (typeof form.requestSubmit === "function") form.requestSubmit()
  else form.submit()
}

/** Tab order as document order over the tabbable elements — the common case.
 *  `tabindex` greater than zero, and elements under a shadow root, are not
 *  ordered specially here. */
function moveFocus(from: Element, direction: 1 | -1): void {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]"
    )
  ).filter((el) => isTabbable(el))
  if (candidates.length === 0) return
  const index = candidates.indexOf(from as HTMLElement)
  const next =
    index === -1
      ? direction === 1
        ? candidates[0]
        : candidates[candidates.length - 1]
      : candidates[(index + direction + candidates.length) % candidates.length]
  next.focus({ preventScroll: true })
}

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false
  if ((el as HTMLInputElement).disabled) return false
  if (el instanceof HTMLInputElement && el.type === "hidden") return false
  const style = getComputedStyle(el)
  if (style.display === "none" || style.visibility === "hidden") return false
  return el.getClientRects().length > 0
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

const OPTIONS_LISTED = 20

/** Choose options by value or by visible label, and tell the page. */
export function selectIn(el: Element, values: string[]): ActionFailure | null {
  const other =
    el instanceof HTMLLabelElement
      ? el.control
      : (el.closest("select") ?? el.querySelector("select"))
  const select =
    el instanceof HTMLSelectElement
      ? el
      : other instanceof HTMLSelectElement && isRendered(other)
        ? other
        : null
  if (!select)
    return { error: "not-editable", detail: `${describe(el)} is not a select` }
  if (isDisabledControl(select))
    return { error: "disabled", detail: `${describe(select)} is disabled` }
  if (values.length === 0)
    return { error: "unsupported", detail: "no value to select" }
  if (!select.multiple && values.length > 1)
    return {
      error: "unsupported",
      detail: `${describe(select)} takes one value`,
    }
  const options = Array.from(select.options)
  const picked: HTMLOptionElement[] = []
  for (const wanted of values) {
    const matches = (o: HTMLOptionElement) =>
      o.value === wanted ||
      o.label === wanted ||
      (o.textContent ?? "").trim() === wanted
    // A disabled option cannot be chosen by a person and is not chosen here;
    // it is named in the refusal so the agent knows it exists. As the spec
    // has it: its own attribute, or a disabled `<optgroup>` it is a child of.
    const usable = (o: HTMLOptionElement) =>
      !o.disabled &&
      !(
        o.parentElement instanceof HTMLOptGroupElement &&
        o.parentElement.disabled
      )
    const option =
      options.find((o) => usable(o) && o.value === wanted) ??
      options.find((o) => usable(o) && matches(o))
    if (!option) {
      const disabled = options.find((o) => !usable(o) && matches(o))
      if (disabled)
        return {
          error: "disabled",
          detail: `option ${JSON.stringify(wanted)} in ${describe(select)} is disabled`,
        }
      const listed = options
        .slice(0, OPTIONS_LISTED)
        .map((o) => JSON.stringify(o.value || o.label))
        .join(", ")
      const more =
        options.length > OPTIONS_LISTED ? `, … (${options.length} in all)` : ""
      return {
        error: "no-option",
        detail: `no option ${JSON.stringify(wanted)} in ${describe(select)}; the options are ${listed}${more}`,
      }
    }
    picked.push(option)
  }
  select.focus({ preventScroll: true })
  for (const option of options) option.selected = false
  for (const option of picked) option.selected = true
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  select.dispatchEvent(new Event("change", { bubbles: true }))
  return null
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** How to name an element in a message: enough for a reader to find it in
 *  the tree, no more. */
export function describe(el: Element): string {
  let name = el.tagName.toLowerCase()
  if (el.id) name += `#${el.id}`
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ")
  if (text) name += ` "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`
  return name
}
