import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/studio",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "./test-results/studio",
  use: {
    baseURL: process.env.STUDIO_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    channel: process.env.STUDIO_BROWSER ?? "chrome",
    screenshot: "only-on-failure",
  },
})
