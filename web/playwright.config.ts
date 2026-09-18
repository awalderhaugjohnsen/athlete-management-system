import { defineConfig } from "@playwright/test";

// Plain Node-context tests (pure functions, no browser) — see playwright-ct.config.ts for the
// separate component-test (browser, mount()) runner.
export default defineConfig({
  testDir: "./tests/unit",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
});
