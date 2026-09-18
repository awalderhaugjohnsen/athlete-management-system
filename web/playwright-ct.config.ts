import { defineConfig, devices } from "@playwright/experimental-ct-react";
import path from "path";

export default defineConfig({
  testDir: "./tests/component",
  snapshotDir: "./tests/component/__snapshots__",
  timeout: 15 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    ctViteConfig: {
      resolve: {
        alias: {
          // Stub Server Action modules before the generic "@" alias so imports of them
          // resolve to the browser-safe stub instead of pulling in server-only code — see
          // playwright/stubs/user-settings.ts for why.
          "@/app/actions/user-settings": path.resolve(__dirname, "./playwright/stubs/user-settings.ts"),
          "@": path.resolve(__dirname, "."),
        },
      },
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
