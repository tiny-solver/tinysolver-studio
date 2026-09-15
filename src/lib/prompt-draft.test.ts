import { describe, expect, it } from "vitest"

import type { PromptDraft, PromptInputBlock } from "@/lib/types"

import {
  buildSteerPayload,
  extractUserImagesFromDraft,
  extractUserResourcesFromDraft,
} from "./prompt-draft"

function draft(blocks: PromptInputBlock[]): PromptDraft {
  return { blocks, displayText: "" }
}

const grokImageResource: PromptInputBlock = {
  type: "resource",
  uri: "clipboard://image.png-abc",
  mime_type: "image/png",
  text: null,
  blob: "QUJD",
}

const textResource: PromptInputBlock = {
  type: "resource",
  uri: "clipboard://notes.txt",
  mime_type: "text/plain",
  text: "hi",
  blob: null,
}

describe("buildSteerPayload", () => {
  const text = (s: string): PromptInputBlock => ({ type: "text", text: s })

  it("joins plain-text blocks and rides no block list", () => {
    const d: PromptDraft = {
      blocks: [text(" go "), text("left")],
      displayText: "ignored",
    }
    expect(buildSteerPayload(d)).toEqual({ text: "go \nleft" })
  })

  it("returns null when there is no text at all", () => {
    expect(buildSteerPayload({ blocks: [], displayText: "" })).toBeNull()
    expect(
      buildSteerPayload({ blocks: [text("   ")], displayText: "" })
    ).toBeNull()
  })

  it("rides the full block list and display text once a non-text block is present", () => {
    const blocks = [text("look"), grokImageResource]
    const d: PromptDraft = { blocks, displayText: "look [附件 1]" }
    expect(buildSteerPayload(d)).toEqual({
      text: "look [附件 1]",
      blocks,
    })
  })

  it("attaches only a text resource too (it is not a text block)", () => {
    const blocks = [text("note"), textResource]
    const d: PromptDraft = { blocks, displayText: "note chip" }
    expect(buildSteerPayload(d)?.blocks).toBe(blocks)
  })
})

describe("extractUserImagesFromDraft", () => {
  it("includes native image blocks", () => {
    const images = extractUserImagesFromDraft(
      draft([
        { type: "image", data: "QUJD", mime_type: "image/png", uri: null },
      ])
    )
    expect(images).toEqual([
      { name: "image.png", data: "QUJD", mime_type: "image/png", uri: null },
    ])
  })

  it("promotes an image-mime embedded resource to a thumbnail (Grok's encoding)", () => {
    const images = extractUserImagesFromDraft(draft([grokImageResource]))
    expect(images).toHaveLength(1)
    // Bytes come from `blob`, and the origin uri is preserved.
    expect(images[0]).toMatchObject({
      data: "QUJD",
      mime_type: "image/png",
      uri: "clipboard://image.png-abc",
    })
  })

  it("ignores a non-image embedded resource", () => {
    expect(extractUserImagesFromDraft(draft([textResource]))).toEqual([])
  })
})

describe("extractUserResourcesFromDraft", () => {
  it("excludes an image-mime embedded resource (it renders as a thumbnail)", () => {
    expect(extractUserResourcesFromDraft(draft([grokImageResource]))).toEqual(
      []
    )
  })

  it("keeps a non-image embedded resource as a chip", () => {
    expect(extractUserResourcesFromDraft(draft([textResource]))).toEqual([
      {
        name: "notes.txt",
        uri: "clipboard://notes.txt",
        mime_type: "text/plain",
      },
    ])
  })
})
