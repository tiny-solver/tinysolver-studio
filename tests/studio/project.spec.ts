import { expect, test } from "@playwright/test"
import { createReadStream, promises as fs } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"

// The whole loop against a real backend: drag → autosave → an "agent" edits
// the file on disk → editor and iframe pick it up → build button → versioned
// folder + zip. Needs a codeg-server serving the static export and a
// content project on disk:
//
//   STUDIO_URL=http://127.0.0.1:3082 STUDIO_TOKEN=dev \
//   STUDIO_PROJECT=/path/to/project STUDIO_SCENE=main pnpm studio:test
//
// Skipped otherwise, so the plain `pnpm studio:test` run stays green.
const PROJECT = process.env.STUDIO_PROJECT
const TOKEN = process.env.STUDIO_TOKEN
const SCENE = process.env.STUDIO_SCENE ?? "main"

test.skip(!PROJECT || !TOKEN, "set STUDIO_PROJECT and STUDIO_TOKEN")

test("drag, autosave, agent edit, reload, build", async ({ page, baseURL }) => {
  const root = PROJECT!
  const scenePath = path.join(
    root,
    "outputs/game/content",
    `${SCENE}.studio.json`
  )
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })

  await page.goto("/login")
  await page.evaluate(
    (token) => localStorage.setItem("codeg_token", token),
    TOKEN!
  )
  await page.goto(`/studio?path=${encodeURIComponent(root)}`)
  await expect(page.locator(".studio-stage-frame")).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole("status").first()).toContainText("Saved to", {
    timeout: 30_000,
  })

  // The engine announced itself: either hot or reload-after-save.
  await expect(page.locator(".studio-context")).toContainText(/Live|Reloads/, {
    timeout: 30_000,
  })

  // The iframe really loaded the served game (module script + scene fetch).
  const frame = page.frameLocator(".studio-stage-frame")
  await expect(frame.locator("canvas")).toBeVisible({ timeout: 30_000 })

  // Drag the first overlay node by 40 screen px and confirm the file moved.
  const before = JSON.parse(await fs.readFile(scenePath, "utf8"))
  const nodeId: string = before.document.nodes[0].id
  const box = page.locator(`.studio-overlay-node[aria-label="${nodeId}"]`)
  await expect(box).toBeVisible()
  const rect = (await box.boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    rect.x + rect.width / 2 + 40,
    rect.y + rect.height / 2 + 20,
    { steps: 8 }
  )
  await page.mouse.up()
  await expect(page.getByRole("status").first()).toContainText("Saved to", {
    timeout: 15_000,
  })
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(scenePath, "utf8")).document.nodes[0]
          .transform.x,
      {
        timeout: 15_000,
      }
    )
    .not.toBe(before.document.nodes[0].transform.x)

  // An agent rewrites the file: the editor reloads it without a click.
  const agent = JSON.parse(await fs.readFile(scenePath, "utf8"))
  agent.name = `agent-${Date.now()}`
  await fs.writeFile(scenePath, JSON.stringify(agent, null, 2) + "\n")
  await expect(page.locator(".studio-canvas-toolbar strong")).toHaveText(
    agent.name,
    {
      timeout: 20_000,
    }
  )

  // Edit vs play, for the managed engine: scripts stand still while editing
  // (so the overlay matches the picture) and run in preview.
  const game = () =>
    page.frames().find((f) => f.url().includes("/content-preview/"))!
  const engineInfo = () =>
    game().evaluate(() => {
      const engine = (
        window as unknown as {
          codegEngine?: {
            mode: string
            VERSION: string
            node(id: string): { y: number } | null
          }
        }
      ).codegEngine
      return engine
        ? {
            mode: engine.mode,
            version: engine.VERSION,
            y: engine.node("hero")?.y ?? null,
          }
        : null
    })
  const usesManagedEngine = (
    await fs.readFile(path.join(root, "outputs/game/index.html"), "utf8")
  ).includes("__codeg/")
  const managed = await engineInfo()
  if (usesManagedEngine) expect(managed?.y).not.toBeNull()
  if (managed && managed.y !== null) {
    expect(managed.mode).toBe("edit")
    const still = managed.y
    await page.waitForTimeout(400)
    expect((await engineInfo())!.y).toBe(still)

    await page.getByRole("button", { name: "Preview", exact: true }).click()
    await expect.poll(async () => (await engineInfo())!.mode).toBe("play")
    await expect
      .poll(async () => (await engineInfo())!.y, { timeout: 10_000 })
      .not.toBe(still)

    await page.getByRole("button", { name: "Edit", exact: true }).click()
    await expect.poll(async () => (await engineInfo())!.mode).toBe("edit")
    expect((await engineInfo())!.y).toBe(still)
  }

  // An agent breaks the engine: the preview server's injected reporter posts
  // the exception and the editor shows it, ready to hand to the chat. The
  // standalone page has no conversation beside it, so the button is off.
  const mainJs = path.join(root, "outputs/game/src/main.js")
  const engine = await fs.readFile(mainJs, "utf8").catch(() => null)
  if (engine !== null) {
    try {
      await fs.writeFile(
        mainJs,
        `${engine}\nsetTimeout(() => { throw new Error("boom-from-test") }, 0)\n`
      )
      await expect(page.locator(".studio-engine-error")).toContainText(
        "boom-from-test",
        { timeout: 30_000 }
      )
      await expect(
        page.getByRole("button", { name: "Send to chat" }).first()
      ).toBeDisabled()
    } finally {
      await fs.writeFile(mainJs, engine)
    }
    // Fixed again: the reload clears the strip.
    await expect(page.locator(".studio-engine-error")).toHaveCount(0, {
      timeout: 30_000,
    })
  }

  // Build.
  await page.getByRole("button", { name: "Build", exact: true }).click()
  await expect(page.locator(".studio-notice")).toContainText("is ready", {
    timeout: 60_000,
  })
  const buildsDir = path.join(root, "build/game")
  const versions = (await fs.readdir(buildsDir)).filter((n) =>
    n.startsWith("v")
  )
  expect(versions.length).toBeGreaterThan(0)
  const sorted = versions.filter((n) => !n.endsWith(".zip")).sort()
  const latest = sorted[sorted.length - 1]
  await fs.access(path.join(buildsDir, latest, "outputs/game/index.html"))
  await fs.access(path.join(buildsDir, `${latest}.zip`))

  // The build is the release: served by any static host, with no Studio and
  // nothing fetched from another origin.
  if (usesManagedEngine) {
    const buildRoot = path.join(buildsDir, latest)
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".json": "application/json",
      ".png": "image/png",
    }
    const server = createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").split("?")[0])
      const file = path.join(
        buildRoot,
        rel.endsWith("/") ? `${rel}index.html` : rel
      )
      if (!file.startsWith(buildRoot)) return void res.writeHead(403).end()
      res.setHeader("content-type", types[path.extname(file)] ?? "text/plain")
      createReadStream(file)
        .on("error", () => res.writeHead(404).end())
        .pipe(res)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const release = await page.context().newPage()
    const offHost: string[] = []
    release.on("request", (request) => {
      if (
        !request.url().startsWith(origin) &&
        !request.url().startsWith("data:")
      )
        offHost.push(request.url())
    })
    const releaseErrors: string[] = []
    release.on("pageerror", (error) => releaseErrors.push(error.message))
    try {
      await release.goto(`${origin}/outputs/game/index.html`)
      await expect(release.locator("canvas")).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() =>
          release.evaluate(
            () =>
              (window as unknown as { codegEngine?: { mode: string } })
                .codegEngine?.mode ?? null
          )
        )
        .toBe("play")
      expect(offHost).toEqual([])
      expect(releaseErrors).toEqual([])
    } finally {
      await release.close()
      server.close()
    }
  }

  await page.screenshot({
    path: "test-results/studio/project-loop.png",
    fullPage: true,
  })
  expect(
    errors.filter(
      (e) => !e.includes("asset missing") && !e.includes("boom-from-test")
    )
  ).toEqual([])
  void baseURL
})
