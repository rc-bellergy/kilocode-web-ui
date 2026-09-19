import { expect, test } from "@playwright/test"
import { PASSWORD, resetMock } from "./helpers"

test.beforeEach(async () => {
  await resetMock()
})

test.describe("E2E-1 password login", () => {
  test("wrong password shows an error", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/login$/)
    await page.fill("#password", "wrong-password")
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page.getByText("Invalid password")).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test("correct password enters the dashboard", async ({ page }) => {
    await page.goto("/")
    await page.fill("#password", PASSWORD)
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible()
    await expect(page).toHaveURL(/localhost:\d+\/$|127\.0\.0\.1:\d+\/$/)
  })

  test("unauthenticated visits redirect to /login", async ({ page }) => {
    await page.goto("/session/ses_whatever")
    await expect(page).toHaveURL(/\/login$/)
  })

  test("logout clears the session cookie", async ({ page }) => {
    await page.goto("/")
    await page.fill("#password", PASSWORD)
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible()
    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page).toHaveURL(/\/login$/)
    // After logout the cookie is gone: navigating back must bounce to /login.
    await page.goto("/")
    await expect(page).toHaveURL(/\/login$/)
  })
})
