import { expect, test } from "@playwright/test"
import { control, mockState } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetMock } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
})

test.describe("E2E-8 abort", () => {
  test("Abort appears while busy, reaches the mock, and status returns to idle", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)

    // Not busy: Send is shown, no Abort.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible()

    // Force the session busy (hung).
    await control("/__control/hang", { sessionID })
    await expect(page.getByRole("button", { name: "Abort" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("working", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Abort" }).click()

    // Mock received the abort call and the session returned to idle.
    await expect(async () => {
      const { aborts } = await mockState()
      expect(aborts).toContain(sessionID)
    }).toPass({ timeout: 10_000 })
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("working", { exact: true })).toHaveCount(0)
  })
})
