import { expect, test, type Page } from "@playwright/test"

async function pixel(page: Page, x: number, y: number) {
  return page.locator(".studio-stage canvas").evaluate(
    (canvas, point) => {
      const source = canvas as HTMLCanvasElement
      const copy = document.createElement("canvas")
      copy.width = source.width
      copy.height = source.height
      const context = copy.getContext("2d")!
      context.drawImage(source, 0, 0)
      return [
        ...context.getImageData(
          Math.floor((point.x / 960) * source.width),
          Math.floor((point.y / 540) * source.height),
          1,
          1
        ).data,
      ]
    },
    { x, y }
  )
}

async function openStudio(page: Page) {
  await page.goto("/studio")
  await expect(page.locator(".studio-stage canvas")).toBeVisible()
  await expect(
    page.getByText("Saved in this browser", { exact: true })
  ).toBeVisible()
}

test("edit, render, command undo, preview interaction, reload and portable image bundle", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  await openStudio(page)
  await expect.poll(() => pixel(page, 480, 205)).toEqual([198, 242, 139, 255])
  await page.screenshot({
    path: "test-results/studio/editor-desktop.png",
    fullPage: true,
  })

  await page.getByRole("button", { name: "Preview", exact: true }).click()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([198, 242, 139, 255])
  const stage = await page.locator(".studio-stage canvas").boundingBox()
  expect(stage).not.toBeNull()
  await page.mouse.click(
    stage!.x + (stage!.width * 480) / 960,
    stage!.y + (stage!.height * 350) / 540
  )
  await expect.poll(() => pixel(page, 480, 205)).toEqual([36, 49, 73, 255])
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([198, 242, 139, 255])

  await page.getByText("Command workspace", { exact: true }).click()
  await page
    .getByRole("button", { name: "Apply commands", exact: true })
    .click()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([255, 204, 102, 255])
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([198, 242, 139, 255])
  await page.getByRole("button", { name: "Redo", exact: true }).click()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([255, 204, 102, 255])

  await page.getByRole("button", { name: "Signal", exact: true }).click()
  await page.getByRole("spinbutton", { name: "X", exact: true }).fill("350")
  await expect(
    page.getByRole("spinbutton", { name: "X", exact: true })
  ).toHaveValue("350")
  const dragStage = await page.locator(".studio-stage canvas").boundingBox()
  expect(dragStage).not.toBeNull()
  await page.mouse.move(
    dragStage!.x + (dragStage!.width * 425) / 960,
    dragStage!.y + (dragStage!.height * 220) / 540
  )
  await page.mouse.down()
  await page.mouse.move(
    dragStage!.x + (dragStage!.width * 485) / 960,
    dragStage!.y + (dragStage!.height * 220) / 540,
    { steps: 8 }
  )
  await page.mouse.up()
  await expect(
    page.getByRole("spinbutton", { name: "X", exact: true })
  ).toHaveValue("410")
  await page.getByRole("button", { name: "Undo", exact: true }).click()
  await expect(
    page.getByRole("spinbutton", { name: "X", exact: true })
  ).toHaveValue("350")
  await expect(
    page.getByText("Saved in this browser", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByText("Saved in this browser", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Signal", exact: true }).click()
  await expect(
    page.getByRole("spinbutton", { name: "X", exact: true })
  ).toHaveValue("350")

  // Generate a tiny test fixture, not a production asset.
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 32
    const context = canvas.getContext("2d")!
    context.fillStyle = "#ff0000"
    context.fillRect(0, 0, 32, 32)
    return canvas.toDataURL().split(",")[1]
  })
  await page
    .locator('input[accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles({
      name: "red-fixture.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })
  await expect(
    page.getByRole("textbox", { name: "Object name", exact: true })
  ).toHaveValue("red-fixture.png")
  await expect.poll(() => pixel(page, 370, 220)).toEqual([255, 0, 0, 255])
  await expect(
    page.getByText("Saved in this browser", { exact: true })
  ).toBeVisible()
  const downloadEvent = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export bundle", exact: true }).click()
  const download = await downloadEvent
  const bundle = await download.path()
  expect(bundle).toBeTruthy()
  await page.getByRole("button", { name: "Delete object", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "red-fixture.png", exact: true })
  ).toHaveCount(0)
  await page
    .locator('input[accept=".json,application/json"]')
    .setInputFiles(bundle!)
  await expect(
    page.getByRole("button", { name: "red-fixture.png", exact: true })
  ).toBeVisible()
  await expect.poll(() => pixel(page, 370, 220)).toEqual([255, 0, 0, 255])
  await expect(
    page.getByText("Saved in this browser", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect.poll(() => pixel(page, 370, 220)).toEqual([255, 0, 0, 255])
  expect(errors).toEqual([])
})

test("plan document and narrow viewport are usable", async ({ page }) => {
  await openStudio(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: "test-results/studio/editor-mobile.png",
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.getByRole("link", { name: "Living plan", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Content Studio", exact: true })
  ).toBeVisible()
  await expect(page.getByText("Three.js + R3F", { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({
    path: "test-results/studio/plan.png",
    fullPage: true,
  })
})

test("Korean browser locale works without a backend", async ({ browser }) => {
  const context = await browser.newContext({
    locale: "ko-KR",
    colorScheme: "dark",
    viewport: { width: 1440, height: 1000 },
  })
  const page = await context.newPage()
  const apiRequests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/")) apiRequests.push(request.url())
  })
  await page.goto(`${process.env.STUDIO_URL ?? "http://localhost:3000"}/studio`)
  await expect(
    page.getByText("이 브라우저에 저장됨", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "미리보기", exact: true })
  ).toBeVisible()
  await expect.poll(() => pixel(page, 480, 205)).toEqual([198, 242, 139, 255])
  await page.screenshot({
    path: "test-results/studio/editor-ko-dark.png",
    fullPage: true,
  })
  expect(apiRequests).toEqual([])
  await context.close()
})
