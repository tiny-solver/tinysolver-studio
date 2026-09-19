import { expect, test } from "@playwright/test"

// The scene editor needs a backend and a project folder (it edits
// `outputs/game/content/*.studio.json` and previews the served game), so
// the full loop is verified against a running `codeg-server` in
// `tests/studio/project.spec.ts`. This spec only covers what the static
// page can show on its own: no project → a clear instruction, no errors.
test("studio without a project folder explains what to open", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await page.goto("/studio")
  await expect(
    page.getByText("Open the Studio from a project folder", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Back to workspace" })
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/studio/editor-no-project.png",
    fullPage: true,
  })
  expect(errors).toEqual([])
})
