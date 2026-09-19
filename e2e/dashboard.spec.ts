import { expect, test } from "@playwright/test"
import { control } from "./mock-kilo-process"
import { createMockSession, login, resetMock } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
})

test.describe("E2E-3 session dashboard", () => {
  test("create → auto-enter, delete → removed from list", async ({ page }) => {
    await page.getByRole("button", { name: "+ New session" }).click()
    await expect(page).toHaveURL(/\/session\/ses_/)
    await page.goto("/")

    const item = page.locator("li", { hasText: "New session -" })
    await expect(item).toHaveCount(1)

    // Delete with confirmation.
    await item.hover()
    await item.getByTitle("Delete session").click()
    await item.getByRole("button", { name: "Delete", exact: true }).click()
    await expect(page.getByText("No sessions yet")).toBeVisible()
  })

  test("busy / retrying / offline chips update live via SSE", async ({ page }) => {
    const sessionID = await createMockSession()
    await expect(page.getByText("New session -", { exact: false })).toBeVisible()

    await control("/__control/status", { sessionID, status: { type: "busy" } })
    await expect(page.locator("li", { hasText: "New session" }).getByText("busy")).toBeVisible()

    await control("/__control/status", { sessionID, status: { type: "retry", attempt: 1, message: "x", next: Date.now() + 5000 } })
    await expect(page.locator("li", { hasText: "New session" }).getByText("retrying")).toBeVisible()

    await control("/__control/status", { sessionID, status: { type: "offline", requestID: "req_1", message: "waiting" } })
    await expect(page.locator("li", { hasText: "New session" }).getByText("offline")).toBeVisible()

    await control("/__control/status", { sessionID, status: { type: "idle" } })
    await expect(page.locator("li", { hasText: "New session" }).getByText("busy")).toHaveCount(0)
  })
})
