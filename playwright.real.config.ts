import { defineConfig, devices } from "@playwright/test"

/**
 * Real-kilo smoke suite (Phase 4 of the test & fix plan).
 *
 * Runs against a REAL `kilo serve` spawned by the backend (plus, for some
 * tests, extra backends / an attached real kilo). Consumes small amounts of
 * real model quota on a few tests, and kills/restarts real kilo processes.
 * Never part of `npm test`; run explicitly with `npm run test:real`.
 */
export default defineConfig({
  testDir: "./e2e-real",
  globalSetup: "./e2e-real/global-setup.ts",
  globalTeardown: "./e2e-real/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    ...devices["iPhone 13"],
    baseURL: "http://127.0.0.1:3210",
    trace: "off",
  },
})
