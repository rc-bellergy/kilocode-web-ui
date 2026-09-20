import { expect, test } from "@playwright/test"
import { PROJECT_A, PROJECT_B, login, resetMock } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
})

test.describe("E2E-2 multi-project switching", () => {
  test("sessions are independent per project", async ({ page }) => {
    const projectSelect = page.getByTitle("Active project")

    // Create a session in project A through the UI.
    await projectSelect.selectOption(PROJECT_A)
    await page.getByRole("button", { name: "New session" }).click()
    await expect(page).toHaveURL(/\/session\//)
    const sessionA = page.url().split("/").pop()!
    await page.goto("/")

    // Switch to project B: A's session must not leak in.
    await projectSelect.selectOption(PROJECT_B)
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible()
    await expect(page.getByText("New session -", { exact: false })).toHaveCount(0)
    await expect(page.getByText("No sessions yet")).toBeVisible()

    // Create a session in B.
    await page.getByRole("button", { name: "New session" }).click()
    await expect(page).toHaveURL(/\/session\//)
    const sessionB = page.url().split("/").pop()!
    await page.goto("/")

    // Switch back to A: only A's session is listed.
    await projectSelect.selectOption(PROJECT_A)
    await expect(page.getByText("No sessions yet")).toHaveCount(0)
    expect(sessionA).not.toBe(sessionB)
    const links = page.locator("a[href^='/session/']")
    await expect(links).toHaveCount(1)
  })
})
