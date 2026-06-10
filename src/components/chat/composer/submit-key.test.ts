import { describe, expect, it } from "vitest"

import {
  shouldSubmitOnEnter,
  type SubmitKeyContext,
  type SubmitKeyEvent,
} from "./submit-key"

const plainEnter: SubmitKeyEvent = {
  key: "Enter",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
}

const topLevel: SubmitKeyContext = {
  composing: false,
  inCodeBlock: false,
  inList: false,
}

describe("shouldSubmitOnEnter", () => {
  it("submits on a plain Enter at the top level", () => {
    expect(shouldSubmitOnEnter(plainEnter, topLevel)).toBe(true)
  })

  it("ignores non-Enter keys", () => {
    expect(shouldSubmitOnEnter({ ...plainEnter, key: "a" }, topLevel)).toBe(
      false
    )
  })

  it.each([
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
  ])("does not submit with the %s modifier (newline / shortcut)", (_n, mod) => {
    expect(shouldSubmitOnEnter({ ...plainEnter, ...mod }, topLevel)).toBe(false)
  })

  describe("IME guard", () => {
    it("does not submit while event.isComposing", () => {
      expect(
        shouldSubmitOnEnter({ ...plainEnter, isComposing: true }, topLevel)
      ).toBe(false)
    })

    it("does not submit on the legacy keyCode 229 sentinel", () => {
      expect(
        shouldSubmitOnEnter({ ...plainEnter, keyCode: 229 }, topLevel)
      ).toBe(false)
    })

    it("does not submit while view.composing", () => {
      expect(
        shouldSubmitOnEnter(plainEnter, { ...topLevel, composing: true })
      ).toBe(false)
    })
  })

  describe("structural Enter", () => {
    it("does not submit inside a code block", () => {
      expect(
        shouldSubmitOnEnter(plainEnter, { ...topLevel, inCodeBlock: true })
      ).toBe(false)
    })

    it("does not submit inside a list item", () => {
      expect(
        shouldSubmitOnEnter(plainEnter, { ...topLevel, inList: true })
      ).toBe(false)
    })
  })

  it("submits on Enter immediately after composition ends (no IME flags set)", () => {
    // Post-composition Enter: isComposing false, keyCode normal, view not
    // composing — this is a genuine submit, not a candidate confirmation.
    expect(shouldSubmitOnEnter(plainEnter, topLevel)).toBe(true)
  })
})
