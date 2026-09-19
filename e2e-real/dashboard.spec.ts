import { expect, test } from "@playwright/test"
import { createSessionViaApi, deleteSessionViaApi, loginReal, selectTestProject } from "./helpers"

test.describe("E2E-3R session dashboard (real kilo)", () => {
  test.beforeEach(async ({ page }) => {
    await loginReal(page)
    await selectTestProject(page)
  })

  test("create via UI → auto-enter → delete → removed", async ({ page }) => {
    const before = await page.locator("a[href^='/session/']").count()
    await page.getByRole("button", { name: "+ New session" }).click()
    await expect(page).toHaveURL(/\/session\/ses_/, { timeout: 30_000 })
    const sessionID = page.url().split("/").pop()!

    await page.goto("/")
    await expect(page.locator("a[href^='/session/']")).toHaveCount(before + 1, { timeout: 30_000 })

    const item = page.locator("li", { hasText: "New session" }).filter({ has: page.locator(`a[href='/session/${sessionID}']`) })
    await item.hover()
    await item.getByTitle("Delete session").click()
    await item.getByRole("button", { name: "Delete", exact: true }).click()
    await expect(page.locator(`a[href='/session/${sessionID}']`)).toHaveCount(0, { timeout: 30_000 })
  })

  test("API-created session appears and can be deleted", async ({ page }) => {
    const dir = await selectTestProject(page)
    const id = await createSessionViaApi(page, dir)
    expect(id).toBeTruthy()
    await expect(page.locator(`a[href='/session/${id}']`)).toBeVisible({ timeout: 30_000 })
    await deleteSessionViaApi(page, id!, dir)
    await expect(page.locator(`a[href='/session/${id}']`)).toHaveCount(0, { timeout: 30_000 })
  })
})
