import { expect, test } from "@playwright/test"
import { control, killMock, startMock } from "./mock-kilo-process"
import { createMockSession, login, resetMock } from "./helpers"

test.beforeEach(async () => {
  await resetMock()
})

test.describe("E2E-9 automatic recovery (attached mode)", () => {
  test("backend re-attaches after the target kilo server restarts (P0-1)", async ({ page }) => {
    await login(page)
    const sessionID = await createMockSession()
    await expect(page.getByText("New session -", { exact: false })).toBeVisible({ timeout: 15_000 })

    // Kill the mock kilo: the backend must notice and surface a banner.
    await killMock()
    await expect(page.locator("div.border-b", { hasText: /unreachable|attach|Cannot attach/i })).toBeVisible({
      timeout: 20_000,
    })

    // API calls fail while kilo is down.
    const healthDown = await page.evaluate(async () => {
      const res = await fetch("/api/health")
      return (await res.json()) as { kilo: { ready: boolean } }
    })
    expect(healthDown.kilo.ready).toBe(false)

    // Restart the mock on the same port: the backend re-attaches by itself
    // (health polling re-kicks the attach cycle), the banner clears, and the
    // proxy works again without reloading the page.
    await startMock()
    await expect(page.getByText(/unreachable|Cannot attach/i)).toHaveCount(0, { timeout: 40_000 })

    // A session created on the revived mock shows up live in this page.
    await control("/__control/create-session", { directory: "/tmp/kilo-e2e/project-a" })
    await expect(page.getByText("New session -").first()).toBeVisible({ timeout: 30_000 })
    void sessionID
  })
})
