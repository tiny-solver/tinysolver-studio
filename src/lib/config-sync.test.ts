import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  CONFIG_DOMAIN_IDS,
  CONFIG_EXPORT_EXTENSION,
  defaultExportFileName,
  exportConfigToFile,
  importPickedConfig,
  pickConfigFileToImport,
  summarizeCounts,
} from "./config-sync"
import { isLocalDesktop } from "./platform"
import { getTransport } from "./transport"

vi.mock("./platform", () => ({ isLocalDesktop: vi.fn() }))
vi.mock("./transport", () => ({ getTransport: vi.fn() }))

const save = vi.fn()
const open = vi.fn()
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => save(...args),
  open: (...args: unknown[]) => open(...args),
}))

const call = vi.fn()
const desktop = vi.mocked(isLocalDesktop)

// jsdom implements neither half of the Blob-download dance.
const createObjectURL = vi.fn(() => "blob:codeg/1")
const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTransport).mockReturnValue({ call } as never)
  call.mockResolvedValue({ content: "{}", counts: {}, path: "", manifest: {} })
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})

describe("defaultExportFileName", () => {
  it("is filesystem-safe and sorts chronologically", () => {
    const name = defaultExportFileName(new Date("2026-05-04T11:32:07.456Z"))
    expect(name).toBe(
      `codeg-config-2026-05-04-11-32-07.${CONFIG_EXPORT_EXTENSION}`
    )
    // Windows rejects ':' in file names — the timestamp must not smuggle one in.
    expect(name).not.toMatch(/[:]/)
    const earlier = defaultExportFileName(new Date("2026-05-04T11:32:06.000Z"))
    expect([name, earlier].sort()).toEqual([earlier, name])
  })
})

describe("summarizeCounts", () => {
  it("keeps the fixed domain order and hides empty domains", () => {
    const [first, second] = CONFIG_DOMAIN_IDS
    const summary = summarizeCounts({ [second]: 2, [first]: 3 } as never)
    expect(summary).toEqual([
      { id: first, count: 3 },
      { id: second, count: 2 },
    ])
  })

  it("treats a missing domain as zero rather than crashing", () => {
    expect(summarizeCounts({} as never)).toEqual([])
  })
})

/**
 * The runtime split lives HERE, not in the panel — the panel only calls these
 * two functions, so a component test that mocks this module proves nothing
 * about which branch a real browser takes. The commands are the observable
 * difference: `*_file` variants take a server-side path and only exist as
 * Tauri commands, so a browser reaching one is a hard failure rather than a
 * degraded experience.
 */
describe("local file transfer picks its runtime", () => {
  it("moves the document's text when there is no local desktop shell", async () => {
    desktop.mockReturnValue(false)
    call.mockResolvedValue({ content: '{"hello":1}', counts: { a: 1 } })

    const summary = await exportConfigToFile()

    expect(call).toHaveBeenCalledWith("config_sync_export_content", {})
    expect(save).not.toHaveBeenCalled()
    // The bytes went out as a download, and the object URL is released rather
    // than leaked for the life of the document.
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:codeg/1"))
    // The browser owns the destination, so the reported "path" is the offered
    // file name rather than anything on a disk.
    expect(summary?.path).toMatch(/^codeg-config-.*\.json$/)
  })

  it("uses the native save dialog on a local desktop window", async () => {
    desktop.mockReturnValue(true)
    save.mockResolvedValue("/Users/someone/config.json")

    await exportConfigToFile()

    expect(save).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("config_sync_export_file", {
      destPath: "/Users/someone/config.json",
    })
    expect(call).not.toHaveBeenCalledWith("config_sync_export_content", {})
  })

  it("does not call the backend at all when the save dialog is dismissed", async () => {
    desktop.mockReturnValue(true)
    save.mockResolvedValue(null)

    expect(await exportConfigToFile()).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("previews a desktop import by path and a browser import by content", async () => {
    desktop.mockReturnValue(true)
    open.mockResolvedValue("/Users/someone/incoming.json")
    const picked = await pickConfigFileToImport()
    expect(call).toHaveBeenCalledWith("config_sync_peek_file", {
      srcPath: "/Users/someone/incoming.json",
    })
    expect(picked?.source).toEqual({
      kind: "path",
      path: "/Users/someone/incoming.json",
      label: "/Users/someone/incoming.json",
    })

    // And the two sources stay apart on the way back in, so a path never
    // reaches the by-content command or the reverse.
    await importPickedConfig(picked!.source)
    expect(call).toHaveBeenCalledWith("config_sync_import_file", {
      srcPath: "/Users/someone/incoming.json",
    })
    await importPickedConfig({ kind: "content", content: "{}", label: "f" })
    expect(call).toHaveBeenCalledWith("config_sync_import_content", {
      content: "{}",
    })
  })

  it("does not open a native dialog from a browser", async () => {
    desktop.mockReturnValue(false)
    // No file is ever selected; the promise settles via the picker's own
    // dismissal path rather than hanging (see `pickLocalFile`).
    const pending = pickConfigFileToImport()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input, "a browser import must go through a file input").not.toBeNull()
    expect(open).not.toHaveBeenCalled()
    input!.dispatchEvent(new Event("cancel"))

    expect(await pending).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  /// The caller disables the whole panel while this promise is pending, so one
  /// that never settles is not a leaked promise — it is a settings page with
  /// every button dead until the page is remounted. `cancel` is not dispatched
  /// by older engines (the WebKitGTK a Linux desktop build can be running is
  /// the realistic one), so regaining window focus with no file attached has
  /// to end it too.
  it("settles when a picker without a cancel event is dismissed", async () => {
    vi.useFakeTimers()
    try {
      desktop.mockReturnValue(false)
      const pending = pickConfigFileToImport()
      expect(document.querySelector('input[type="file"]')).not.toBeNull()

      // The picker closed: focus comes back, no file was chosen, and no
      // `cancel` is coming.
      window.dispatchEvent(new Event("focus"))
      await vi.advanceTimersByTimeAsync(1000)

      expect(await pending).toBeNull()
      expect(document.querySelector('input[type="file"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
