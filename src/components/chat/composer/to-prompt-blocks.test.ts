import { Editor } from "@tiptap/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { PromptInputBlock } from "@/lib/types"

import { buildComposerExtensions } from "./editor-config"
import { docToPromptBlocks } from "./to-prompt-blocks"
import type { ReferenceAttrs } from "./types"

function ref(
  partial: Partial<ReferenceAttrs> & { refType: ReferenceAttrs["refType"] }
): ReferenceAttrs {
  return { id: "", label: "", uri: null, meta: null, ...partial }
}

/** Find the single text block (asserts exactly one exists). */
function textBlock(blocks: PromptInputBlock[]): string {
  const texts = blocks.filter((b) => b.type === "text")
  expect(texts).toHaveLength(1)
  return (texts[0] as Extract<PromptInputBlock, { type: "text" }>).text
}

function links(
  blocks: PromptInputBlock[]
): Extract<PromptInputBlock, { type: "resource_link" }>[] {
  return blocks.filter(
    (b): b is Extract<PromptInputBlock, { type: "resource_link" }> =>
      b.type === "resource_link"
  )
}

describe("docToPromptBlocks", () => {
  let editor: Editor

  beforeEach(() => {
    editor = new Editor({ extensions: buildComposerExtensions() })
  })

  afterEach(() => {
    editor?.destroy()
  })

  it("serializes plain prose to a single text block", () => {
    editor.commands.setContent("hello **world**", { contentType: "markdown" })
    const blocks = docToPromptBlocks(editor)
    expect(blocks).toHaveLength(1)
    expect(textBlock(blocks)).toContain("**world**")
  })

  it("returns no blocks for an empty document", () => {
    expect(docToPromptBlocks(editor)).toEqual([])
  })

  it("keeps an agent reference inline as text (no resource_link)", () => {
    editor
      .chain()
      .insertContent("ask ")
      .insertReference(ref({ refType: "agent", id: "codex", label: "Codex" }))
      .run()
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("@Codex")
  })

  it("keeps an agent reference with a codeg uri inline as a markdown link", () => {
    editor
      .chain()
      .insertContent("ask ")
      .insertReference(
        ref({
          refType: "agent",
          id: "codex",
          label: "Codex",
          uri: "codeg://agent/codex",
        })
      )
      .run()
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("[@Codex](codeg://agent/codex)")
  })

  it("keeps a skill reference inline as the /id token", () => {
    editor.commands.insertReference(
      ref({ refType: "skill", id: "code-review", label: "Code Review" })
    )
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("/code-review")
  })

  it("keeps a session reference inline as a codeg:// link (no resource_link)", () => {
    editor
      .chain()
      .insertContent("see ")
      .insertReference(
        ref({
          refType: "session",
          id: "1",
          label: "Login refactor",
          uri: "codeg://session/1",
        })
      )
      .run()
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("codeg://session/1")
  })

  it("keeps a commit reference inline as a codeg:// link (no resource_link)", () => {
    editor.commands.insertReference(
      ref({
        refType: "commit",
        id: "abc1234def",
        label: "abc1234",
        uri: "codeg://commit/%2Frepo@abc1234def",
      })
    )
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("codeg://commit/")
  })

  it("does not lift a file-typed reference carrying a non-file (codeg) uri", () => {
    // A pasted/forged node could be refType "file" with a codeg: uri (the node's
    // parseHTML allow-list permits codeg:). It must stay inline, never become an
    // ACP resource_link with a non-fetchable uri.
    editor.commands.insertReference(
      ref({
        refType: "file",
        id: "x",
        label: "x",
        uri: "codeg://session/9",
      })
    )
    const blocks = docToPromptBlocks(editor)
    expect(links(blocks)).toHaveLength(0)
    expect(textBlock(blocks)).toContain("codeg://session/9")
  })

  it("lifts a file reference to a trailing resource_link and drops it from the prose", () => {
    editor
      .chain()
      .insertContent("see ")
      .insertReference(
        ref({
          refType: "file",
          id: "src/app.ts",
          label: "app.ts",
          uri: "file:///repo/src/app.ts",
        })
      )
      .insertContent(" please")
      .run()
    const blocks = docToPromptBlocks(editor)
    const text = textBlock(blocks)
    expect(text).toContain("see")
    expect(text).toContain("please")
    expect(text).not.toContain("file://")
    expect(text).not.toContain("app.ts")
    expect(links(blocks)).toEqual([
      {
        type: "resource_link",
        uri: "file:///repo/src/app.ts",
        name: "app.ts",
        mime_type: null,
        description: null,
      },
    ])
  })

  it("emits a file-only document as just the resource_link (no empty text block)", () => {
    editor.commands.insertReference(
      ref({
        refType: "file",
        id: "a.ts",
        label: "a.ts",
        uri: "file:///repo/a.ts",
      })
    )
    const blocks = docToPromptBlocks(editor)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: "resource_link",
      uri: "file:///repo/a.ts",
    })
  })

  it("preserves document order across multiple file references", () => {
    editor
      .chain()
      .insertContent("a ")
      .insertReference(
        ref({
          refType: "file",
          id: "1",
          label: "one.ts",
          uri: "file:///one.ts",
        })
      )
      .insertContent(" b ")
      .insertReference(
        ref({
          refType: "file",
          id: "2",
          label: "two.ts",
          uri: "file:///two.ts",
        })
      )
      .run()
    const uris = links(docToPromptBlocks(editor)).map((l) => l.uri)
    expect(uris).toEqual(["file:///one.ts", "file:///two.ts"])
  })

  it("falls back to the uri basename when a file reference has no label", () => {
    editor.commands.insertReference(
      ref({
        refType: "file",
        id: "",
        label: "",
        uri: "file:///repo/deep/name.ts",
      })
    )
    expect(links(docToPromptBlocks(editor))[0].name).toBe("name.ts")
  })

  it("preserves marks in prose alongside a lifted file reference", () => {
    editor
      .chain()
      .insertContent("look at ")
      .insertContent({ type: "text", marks: [{ type: "bold" }], text: "this" })
      .insertContent(" ")
      .insertReference(
        ref({ refType: "file", id: "x", label: "x.ts", uri: "file:///x.ts" })
      )
      .run()
    const blocks = docToPromptBlocks(editor)
    expect(textBlock(blocks)).toContain("**this**")
    expect(links(blocks)).toHaveLength(1)
  })
})
