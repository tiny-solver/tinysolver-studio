// @vitest-environment node
import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { createDemoDocument } from "./document"
import { exportBundle, importBundle, loadDraft, saveDraft } from "./storage"

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("codeg-content-studio-v1")
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
})

describe("Studio storage", () => {
  it("persists and restores a document", async () => {
    expect(await loadDraft()).toBeNull()
    const document = createDemoDocument()
    expect(await saveDraft(document, new Map(), 0)).toBe(1)
    expect(await loadDraft()).toEqual({
      document,
      version: 1,
      blobs: new Map(),
    })
  })

  it("rejects a stale tab without overwriting the newer draft", async () => {
    const document = createDemoDocument()
    await saveDraft(document, new Map(), 0)
    await expect(
      saveDraft({ ...document, name: "Stale writer" }, new Map(), 0)
    ).rejects.toThrow("Another tab")
    expect((await loadDraft())?.document.name).toBe(document.name)
  })

  it("saves blobs and metadata together, and aborts when any bytes are absent", async () => {
    const document = createDemoDocument()
    await saveDraft(document, new Map(), 0)
    const blob = new Blob(["test-image-bytes"], { type: "image/png" })
    const asset = {
      id: "asset-1",
      name: "Image",
      mime: "image/png" as const,
      width: 10,
      height: 10,
      size: blob.size,
    }
    const next = { ...document, assets: [asset] }
    await expect(saveDraft(next, new Map(), 1)).rejects.toThrow("Missing asset")
    expect((await loadDraft())?.version).toBe(1)
    await saveDraft(next, new Map([[asset.id, blob]]), 1)
    const loaded = await loadDraft()
    expect(await loaded?.blobs.get(asset.id)?.text()).toBe("test-image-bytes")
    expect(loaded?.document.assets).toEqual([asset])
  })

  it("round-trips an asset-free bundle and rejects arbitrary JSON", async () => {
    const document = createDemoDocument()
    const result = await importBundle(await exportBundle(document, new Map()))
    expect(result).toEqual({ document, blobs: new Map() })
    await expect(importBundle('{"document":{}}')).rejects.toThrow(
      "Not a Studio bundle"
    )
  })
})
