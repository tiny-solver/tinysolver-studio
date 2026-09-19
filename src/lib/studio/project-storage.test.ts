// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createStarterScene } from "./document"

const readContentProject = vi.fn()
const readFileForEdit = vi.fn()
const writeWorkspaceFileBase64 = vi.fn()
const listContentScenes = vi.fn()

vi.mock("@/lib/api", () => ({
  readContentProject: (...args: unknown[]) => readContentProject(...args),
  readFileForEdit: (...args: unknown[]) => readFileForEdit(...args),
  writeWorkspaceFileBase64: (...args: unknown[]) =>
    writeWorkspaceFileBase64(...args),
  listContentScenes: (...args: unknown[]) => listContentScenes(...args),
}))

import {
  affectsPreview,
  createScene,
  loadScene,
  resolveProjectTarget,
  saveScene,
  scenePath,
} from "./project-storage"

const notFound = () =>
  Promise.reject({ code: "not_found", message: "File does not exist" })

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8")

beforeEach(() => vi.clearAllMocks())

describe("Studio project storage", () => {
  it("follows the manifest's paths and falls back without one", async () => {
    readContentProject.mockResolvedValueOnce({
      paths: { outputs: "out", assets: "art" },
      engine: { entry: "out/game/play.html" },
      name: "x",
    })
    const target = await resolveProjectTarget("/p")
    expect(scenePath(target, "main")).toBe("out/game/content/main.studio.json")
    expect(target.entry).toBe("out/game/play.html")
    expect(affectsPreview(target, "art/bg.png")).toBe(true)
    expect(affectsPreview(target, "out/game/src/main.js")).toBe(true)
    expect(affectsPreview(target, "bible/world.md")).toBe(false)

    readContentProject.mockResolvedValueOnce(null)
    const plain = await resolveProjectTarget("/p")
    expect(plain.manifest).toBeNull()
    expect(scenePath(plain, "main")).toBe(
      "outputs/game/content/main.studio.json"
    )
    expect(plain.entry).toBe("outputs/game/index.html")
  })

  it("loads null when the scene file is absent", async () => {
    readContentProject.mockResolvedValueOnce(null)
    const target = await resolveProjectTarget("/p")
    readFileForEdit.mockImplementationOnce(notFound)
    expect(await loadScene(target, "main")).toBeNull()
  })

  it("loads a scene, pins its id to the file name, and reports migrations", async () => {
    readContentProject.mockResolvedValueOnce(null)
    const target = await resolveProjectTarget("/p")
    const scene = createStarterScene("other")
    readFileForEdit.mockResolvedValueOnce({
      content: JSON.stringify(scene),
      etag: "e1",
    })
    const loaded = await loadScene(target, "main")
    expect(loaded?.scene.id).toBe("main")
    expect(loaded?.etag).toBe("e1")
    expect(loaded?.migrated).toBe(false)

    readFileForEdit.mockResolvedValueOnce({
      content: JSON.stringify({
        format: "codeg-studio-project",
        document: {
          schemaVersion: 1,
          id: "old",
          name: "Old",
          width: 960,
          height: 540,
          background: "#000000",
          assets: [],
          nodes: [],
        },
      }),
      etag: "e2",
    })
    const legacy = await loadScene(target, "main")
    expect(legacy?.migrated).toBe(true)
    expect(legacy?.scene.id).toBe("main")
  })

  it("saves through the etag guard and writes pretty JSON", async () => {
    readContentProject.mockResolvedValueOnce(null)
    const target = await resolveProjectTarget("/p")
    writeWorkspaceFileBase64.mockResolvedValueOnce({ etag: "e2" })
    const scene = createStarterScene("main")
    expect(await saveScene(target, scene, "e1")).toBe("e2")
    const [root, path, data, etag] = writeWorkspaceFileBase64.mock.calls[0]
    expect(root).toBe("/p")
    expect(path).toBe("outputs/game/content/main.studio.json")
    expect(etag).toBe("e1")
    expect(JSON.parse(decode(data))).toEqual(scene)
    expect(decode(data).endsWith("\n")).toBe(true)

    writeWorkspaceFileBase64.mockRejectedValueOnce({
      code: "invalid_input",
      message: "File has changed on disk. Reload the file before saving.",
    })
    await expect(saveScene(target, scene, "stale")).rejects.toMatchObject({
      code: "invalid_input",
    })
  })

  it("creates a starter scene only when the file does not exist", async () => {
    readContentProject.mockResolvedValueOnce(null)
    const target = await resolveProjectTarget("/p")
    readFileForEdit.mockImplementationOnce(notFound)
    writeWorkspaceFileBase64.mockResolvedValueOnce({ etag: "new" })
    const created = await createScene(target, "intro", "Intro")
    expect(created.etag).toBe("new")
    expect(created.scene.name).toBe("Intro")
    expect(writeWorkspaceFileBase64.mock.calls[0][3]).toBeNull()

    readFileForEdit.mockResolvedValueOnce({ content: "{}", etag: "x" })
    await expect(createScene(target, "intro")).rejects.toThrow("already exists")
  })
})
