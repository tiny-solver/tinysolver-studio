import { afterEach, describe, expect, it, vi } from "vitest"

import {
  clickAt,
  isDisabledControl,
  keyDescription,
  pressOn,
  selectIn,
  typeInto,
} from "./act"

/**
 * What can be proved under jsdom: the event sequences, the key table, the
 * default actions that are emulated, and the direct-set fallback for text
 * (jsdom has no `execCommand`, which is exactly the path an engine takes for
 * an input type with no selection). Where a box on screen matters —
 * `pointAt`, `obstructionAt`, the trusted path's `locate` — jsdom reports
 * every element as zero-sized, and the Chrome probe covers it instead.
 */

function mount(html: string): HTMLElement {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("clickAt", () => {
  it("delivers the sequence a page expects of a click, and focuses like a mousedown would", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    const seen: string[] = []
    for (const type of [
      "mouseover",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
    ])
      button.addEventListener(type, () => seen.push(type))
    clickAt(button, { x: 10, y: 10 }, "left", 1)
    expect(seen).toEqual(["mouseover", "mousedown", "mouseup", "click"])
    expect(document.activeElement).toBe(button)
  })

  it("does not move focus when the page cancelled the mousedown", () => {
    const root = mount(`<input id="keep"><button id="b">Go</button>`)
    const keep = root.querySelector<HTMLInputElement>("#keep")!
    const button = root.querySelector("button")!
    keep.focus()
    button.addEventListener("mousedown", (e) => e.preventDefault())
    clickAt(button, { x: 10, y: 10 }, "left", 1)
    expect(document.activeElement).toBe(keep)
  })

  it("adds a dblclick after two clicks and a contextmenu for the right button", () => {
    const root = mount(`<div id="d" tabindex="0">x</div>`)
    const div = root.querySelector("div")!
    const seen: string[] = []
    for (const type of ["click", "dblclick", "contextmenu"])
      div.addEventListener(type, () => seen.push(type))
    clickAt(div, { x: 1, y: 1 }, "left", 2)
    expect(seen).toEqual(["click", "click", "dblclick"])
    seen.length = 0
    clickAt(div, { x: 1, y: 1 }, "right", 1)
    expect(seen).toEqual(["contextmenu"])
  })

  // A dispatched click still carries the element's activation behaviour:
  // that is the difference between clicking a checkbox and telling it about
  // a click.
  // The Pointer Events rule: a cancelled pointerdown suppresses the
  // compatibility mouse events and the focus change, and click still comes.
  it("suppresses mousedown, mouseup and focus when pointerdown was cancelled", () => {
    const root = mount(`<input id="keep"><button id="b">Go</button>`)
    const keep = root.querySelector<HTMLInputElement>("#keep")!
    const button = root.querySelector("button")!
    keep.focus()
    const seen: string[] = []
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"])
      button.addEventListener(type, (e) => {
        seen.push(type)
        if (type === "pointerdown") e.preventDefault()
      })
    clickAt(button, { x: 1, y: 1 }, "left", 1)
    // jsdom has no PointerEvent, so the pointer events arrive as MouseEvents
    // under the pointer type names; the ordering is what is asserted.
    expect(seen).toEqual(["pointerdown", "click"])
    expect(document.activeElement).toBe(keep)
  })

  it("stops a multi-click once the page is no longer the one the ref came from", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    let clicks = 0
    let doubles = 0
    button.addEventListener("click", () => clicks++)
    button.addEventListener("dblclick", () => doubles++)
    let current = true
    const delivered = clickAt(button, { x: 1, y: 1 }, "left", 3, () => {
      const answer = current
      current = false
      return answer
    })
    expect(delivered).toBe(2)
    expect(clicks).toBe(2)
    // A run that was stopped short sends nothing further to the element.
    expect(doubles).toBe(0)
  })

  it("activates the element: a checkbox toggles", () => {
    const root = mount(`<input type="checkbox" id="c">`)
    const box = root.querySelector<HTMLInputElement>("input")!
    clickAt(box, { x: 1, y: 1 }, "left", 1)
    expect(box.checked).toBe(true)
  })
})

describe("typeInto", () => {
  it("replaces the value and tells the page in the order a keyboard would", () => {
    const root = mount(`<input id="q" value="old">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const seen: string[] = []
    input.addEventListener("input", (e) =>
      seen.push(`input:${(e.target as HTMLInputElement).value}`)
    )
    input.addEventListener("change", () => seen.push("change"))
    expect(typeInto(input, "new")).toBeNull()
    expect(input.value).toBe("new")
    expect(seen).toEqual(["input:new", "change"])
    expect(document.activeElement).toBe(input)
  })

  // The value is set through the prototype's setter, not the instance: a
  // page that put a tracking property on the node (React's value tracker) has
  // to see the new value when the `input` event arrives, or it decides
  // nothing changed and drops the event.
  it("sets the value on the element, past an instance property a page defined", () => {
    const root = mount(`<input id="q">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!
    let tracked = ""
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => setter.get!.call(input),
      set: (v: string) => {
        tracked = v
        setter.set!.call(input, v)
      },
    })
    typeInto(input, "typed")
    // The instance setter never ran — the prototype's did — so the page's
    // tracker still holds the old value, which is the state in which React
    // notices a change.
    expect(tracked).toBe("")
    expect(setter.get!.call(input)).toBe("typed")
  })

  it("follows a label to its control and reaches into a wrapper", () => {
    const root = mount(
      `<label for="n">Name</label><input id="n"><div id="wrap"><textarea></textarea></div>`
    )
    expect(typeInto(root.querySelector("label")!, "Ada")).toBeNull()
    expect(root.querySelector<HTMLInputElement>("#n")!.value).toBe("Ada")
    expect(typeInto(root.querySelector("#wrap")!, "notes")).toBeNull()
    expect(root.querySelector("textarea")!.value).toBe("notes")
  })

  it("refuses what takes no text, and says so", () => {
    const root = mount(
      `<button id="b">Go</button><input id="ro" readonly><input id="dis" disabled><input id="cb" type="checkbox">`
    )
    expect(typeInto(root.querySelector("#b")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(typeInto(root.querySelector("#ro")!, "x")?.detail).toContain(
      "read-only"
    )
    expect(typeInto(root.querySelector("#dis")!, "x")).toMatchObject({
      error: "disabled",
    })
    // Disabled through the fieldset, with nothing on the field itself.
    const fenced = mount(`<fieldset disabled><input id="f"></fieldset>`)
    expect(typeInto(fenced.querySelector("#f")!, "x")).toMatchObject({
      error: "disabled",
    })
    expect(typeInto(root.querySelector("#cb")!, "x")).toMatchObject({
      error: "not-editable",
    })
  })

  // A label may lead to its control, but only to one a person could reach:
  // a hidden input behind a visible label is not typed into.
  it("does not follow a label or a wrapper to a hidden control", () => {
    const root = mount(
      `<label for="h">Public</label><input id="h" style="display:none"><div id="w"><textarea style="visibility:hidden"></textarea></div>
       <label for="deep">Deep</label><div style="display:none"><div><input id="deep"></div></div>`
    )
    expect(typeInto(root.querySelector("label")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(typeInto(root.querySelector("#w")!, "x")).toMatchObject({
      error: "not-editable",
    })
    expect(root.querySelector<HTMLInputElement>("#h")!.value).toBe("")
    // Hidden by an ancestor: the control's own display is still "inline-block".
    expect(
      typeInto(root.querySelector('label[for="deep"]')!, "x")
    ).toMatchObject({ error: "not-editable" })
    expect(root.querySelector<HTMLInputElement>("#deep")!.value).toBe("")
  })

  // The fallback walk (engines without `checkVisibility`) treats a
  // `content-visibility: hidden` ancestor like `display: none`.
  it("does not reach a control under a content-visibility: hidden ancestor", () => {
    const root = mount(
      `<label for="cv">Folded</label><section id="fold"><input id="cv"></section>`
    )
    const fold = root.querySelector("#fold")!
    const original = window.getComputedStyle.bind(window)
    const spy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((el: Element) => {
        const style = original(el)
        if (el === fold)
          Object.defineProperty(style, "contentVisibility", {
            value: "hidden",
            configurable: true,
          })
        return style
      })
    try {
      expect(typeInto(root.querySelector("label")!, "x")).toMatchObject({
        error: "not-editable",
      })
      expect(root.querySelector<HTMLInputElement>("#cv")!.value).toBe("")
    } finally {
      spy.mockRestore()
    }
  })

  it("clears a field when given nothing", () => {
    const root = mount(`<input id="q" value="old">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    expect(typeInto(input, "")).toBeNull()
    expect(input.value).toBe("")
  })
})

describe("keyDescription", () => {
  it("knows the named keys, single characters and modifier chords", () => {
    expect(keyDescription("Enter")).toMatchObject({
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      printable: false,
    })
    expect(keyDescription("a")).toMatchObject({
      key: "a",
      code: "KeyA",
      keyCode: 65,
      printable: true,
    })
    expect(keyDescription("7")).toMatchObject({ code: "Digit7", keyCode: 55 })
    expect(keyDescription("Control+Shift+k")).toMatchObject({
      key: "k",
      ctrl: true,
      shift: true,
      alt: false,
      meta: false,
    })
    expect(keyDescription("Meta+Enter")).toMatchObject({
      key: "Enter",
      meta: true,
    })
    expect(keyDescription("Cmd+a")).toMatchObject({ key: "a", meta: true })
  })

  it("accepts the aliases people type and a literal plus", () => {
    expect(keyDescription("Esc")?.key).toBe("Escape")
    expect(keyDescription("Return")?.key).toBe("Enter")
    expect(keyDescription(" ")).toMatchObject({ key: " ", code: "Space" })
    expect(keyDescription("Space")).toMatchObject({ key: " ", code: "Space" })
    expect(keyDescription("Shift++")).toMatchObject({ key: "+", shift: true })
  })

  it("refuses a name it does not know rather than inventing a key", () => {
    expect(keyDescription("Foo")).toBeNull()
    expect(keyDescription("Hyper+a")).toBeNull()
    expect(keyDescription("")).toBeNull()
  })
})

describe("pressOn", () => {
  it("dispatches keydown and keyup on the element, focusing it first", () => {
    const root = mount(`<input id="q">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    const seen: string[] = []
    input.addEventListener("keydown", (e) =>
      seen.push(`down:${e.key}:${e.code}`)
    )
    input.addEventListener("keyup", (e) => seen.push(`up:${e.key}`))
    expect(pressOn(input, "Escape")).toBeNull()
    expect(seen).toEqual(["down:Escape:Escape", "up:Escape"])
    expect(document.activeElement).toBe(input)
  })

  it("goes to whatever has focus when given no element", () => {
    const root = mount(`<input id="a"><input id="b">`)
    const b = root.querySelector<HTMLInputElement>("#b")!
    b.focus()
    const seen: string[] = []
    b.addEventListener("keydown", (e) => seen.push(e.key))
    pressOn(null, "ArrowDown")
    expect(seen).toEqual(["ArrowDown"])
  })

  // The default action an agent presses Enter *for*. Through the default
  // button when there is one, so that button's own handler runs the way it
  // would for a person.
  it("submits a text field's form on Enter through its default button", () => {
    const root = mount(
      `<form id="f"><input id="q"><button type="submit" id="go">Go</button></form>`
    )
    const form = root.querySelector("form")!
    const seen: string[] = []
    root
      .querySelector("#go")!
      .addEventListener("click", () => seen.push("button"))
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      seen.push("submit")
    })
    pressOn(root.querySelector("#q")!, "Enter")
    expect(seen).toEqual(["button", "submit"])
  })

  it("does not submit when a keydown handler cancelled Enter", () => {
    const root = mount(
      `<form><input id="q"><button type="submit">Go</button></form>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    const input = root.querySelector<HTMLInputElement>("#q")!
    input.addEventListener("keydown", (e) => e.preventDefault())
    pressOn(input, "Enter")
    expect(submitted).not.toHaveBeenCalled()
  })

  it("does not submit a buttonless form with two text fields, as the spec says", () => {
    const root = mount(`<form><input id="a"><input id="b"></form>`)
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    pressOn(root.querySelector("#a")!, "Enter")
    expect(submitted).not.toHaveBeenCalled()
  })

  it("activates a button on Enter and on Space", () => {
    const root = mount(`<button id="b">Go</button>`)
    const button = root.querySelector("button")!
    const clicked = vi.fn()
    button.addEventListener("click", clicked)
    pressOn(button, "Enter")
    pressOn(button, "Space")
    expect(clicked).toHaveBeenCalledTimes(2)
  })

  it("types a printable key into the field, after a keypress the page may cancel", () => {
    const root = mount(`<input id="q" value="ab">`)
    const input = root.querySelector<HTMLInputElement>("input")!
    input.focus()
    input.setSelectionRange(2, 2)
    pressOn(input, "c")
    expect(input.value).toBe("abc")
    input.addEventListener("keypress", (e) => e.preventDefault())
    pressOn(input, "d")
    expect(input.value).toBe("abc")
  })

  it("moves focus on Tab, and back on Shift+Tab", () => {
    const root = mount(`<input id="a"><input id="b"><input id="c">`)
    // jsdom has no layout; make the tabbable check see boxes.
    for (const el of root.querySelectorAll("input"))
      vi.spyOn(el, "getClientRects").mockReturnValue([
        new DOMRect(0, 0, 10, 10),
      ] as unknown as DOMRectList)
    const a = root.querySelector<HTMLInputElement>("#a")!
    pressOn(a, "Tab")
    expect(document.activeElement?.id).toBe("b")
    pressOn(null, "Tab")
    expect(document.activeElement?.id).toBe("c")
    pressOn(null, "Shift+Tab")
    expect(document.activeElement?.id).toBe("b")
  })

  it("does not submit on Alt+Enter, and does submit on Meta+Enter", () => {
    const root = mount(
      `<form><input id="q"><button type="submit">Go</button></form>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    const input = root.querySelector<HTMLInputElement>("#q")!
    pressOn(input, "Alt+Enter")
    expect(submitted).not.toHaveBeenCalled()
    pressOn(input, "Meta+Enter")
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it("refuses a disabled control, and never submits from one", () => {
    const root = mount(
      `<form><input id="d" disabled><button type="submit">Go</button></form><fieldset disabled><button id="in">In</button></fieldset>`
    )
    const submitted = vi.fn()
    root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      submitted()
    })
    expect(pressOn(root.querySelector("#d")!, "Enter")).toMatchObject({
      error: "disabled",
    })
    expect(submitted).not.toHaveBeenCalled()
    expect(isDisabledControl(root.querySelector("#in")!)).toBe(true)
    expect(isDisabledControl(root.querySelector("button[type=submit]")!)).toBe(
      false
    )
  })

  it("names an unknown key instead of pressing something else", () => {
    const root = mount(`<input>`)
    expect(pressOn(root.querySelector("input")!, "Bogus")).toMatchObject({
      error: "unsupported",
    })
  })
})

describe("selectIn", () => {
  const html = `<label for="s">Size</label><select id="s">
      <option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option>
    </select><select id="multi" multiple><option value="1">One</option><option value="2">Two</option></select>`

  it("picks by value or by label and tells the page", () => {
    const root = mount(html)
    const select = root.querySelector<HTMLSelectElement>("#s")!
    const seen: string[] = []
    select.addEventListener("input", () => seen.push("input"))
    select.addEventListener("change", () => seen.push(`change:${select.value}`))
    expect(selectIn(select, ["l"])).toBeNull()
    expect(seen).toEqual(["input", "change:l"])
    expect(selectIn(root.querySelector("label")!, ["Small"])).toBeNull()
    expect(select.value).toBe("s")
  })

  it("selects several in a multiple select, and only one in a single", () => {
    const root = mount(html)
    const multi = root.querySelector<HTMLSelectElement>("#multi")!
    expect(selectIn(multi, ["1", "Two"])).toBeNull()
    expect(Array.from(multi.selectedOptions).map((o) => o.value)).toEqual([
      "1",
      "2",
    ])
    expect(selectIn(root.querySelector("#s")!, ["s", "m"])).toMatchObject({
      error: "unsupported",
    })
  })

  it("lists the options when one does not exist", () => {
    const root = mount(html)
    const failure = selectIn(root.querySelector("#s")!, ["xl"])
    expect(failure).toMatchObject({ error: "no-option" })
    expect(failure?.detail).toContain('"xl"')
    expect(failure?.detail).toContain('"m"')
  })

  it("never picks a disabled option, and says that is why", () => {
    const root = mount(
      `<select id="s"><option value="a">A</option><option value="b" disabled>B</option><optgroup disabled><option value="c">C</option></optgroup></select>`
    )
    const failure = selectIn(root.querySelector("#s")!, ["b"])
    expect(failure).toMatchObject({ error: "disabled" })
    expect(root.querySelector<HTMLSelectElement>("#s")!.value).toBe("a")
    // Disabled through its group, with nothing on the option itself.
    expect(selectIn(root.querySelector("#s")!, ["c"])).toMatchObject({
      error: "disabled",
    })
    expect(root.querySelector<HTMLSelectElement>("#s")!.value).toBe("a")
  })

  it("refuses what is not a select", () => {
    const root = mount(`<input id="i">`)
    expect(selectIn(root.querySelector("#i")!, ["a"])).toMatchObject({
      error: "not-editable",
    })
  })
})
