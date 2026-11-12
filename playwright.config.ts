import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: "list",
  projects:
    process.env.BROWSER_MATRIX === "1"
      ? [
          { name: "chromium", use: { browserName: "chromium" } },
          { name: "firefox", use: { browserName: "firefox", launchOptions: {} } },
          { name: "webkit", use: { browserName: "webkit", launchOptions: {} } },
        ]
      : undefined,
  use: {
    baseURL: process.env.APP_ORIGIN ?? "http://localhost:4310",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
});
