import { expect, test } from "@playwright/test"
import { promises as fs } from "node:fs"
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

  await page.screenshot({
    path: "test-results/studio/project-loop.png",
    fullPage: true,
  })
  expect(errors.filter((e) => !e.includes("asset missing"))).toEqual([])
  void baseURL
})
