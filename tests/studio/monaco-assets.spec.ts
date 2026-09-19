import { expect, test } from "@playwright/test"

test("local Monaco assets create a working editor without a CDN", async ({
  page,
}) => {
  const failed: string[] = []
  page.on("requestfailed", (request) => failed.push(request.url()))
  await page.goto("/studio")
  await page.addScriptTag({ url: "/vs/loader.js" })
  const content = await page.evaluate(async () => {
    type MonacoWindow = Window & {
      require: {
        config: (options: { paths: { vs: string } }) => void;
        (
          modules: string[],
          ready: () => void,
          error: (e: unknown) => void
        ): void
      }
      monaco: {
        editor: {
          create: (
            element: HTMLElement,
            options: { value: string; language: string }
          ) => { getValue: () => string; dispose: () => void }
        }
      }
    }
    const runtime = window as unknown as MonacoWindow
    runtime.require.config({ paths: { vs: "/vs" } })
    await new Promise<void>((resolve, reject) => {
      runtime.require(["vs/editor/editor.main"], resolve, reject)
    })
    const host = document.createElement("div")
    host.style.cssText = "width:600px;height:300px"
    document.body.append(host)
    const editor = runtime.monaco.editor.create(host, {
      value: "const game = 1",
      language: "javascript",
    })
    const value = editor.getValue()
    editor.dispose()
    host.remove()
    return value
  })
  expect(content).toBe("const game = 1")
  expect(failed.filter((url) => url.includes("/vs/"))).toEqual([])
})
