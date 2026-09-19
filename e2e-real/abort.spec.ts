import { expect, test } from "@playwright/test"
import { createSessionViaApi, deleteSessionViaApi, loginReal, selectTestProject } from "./helpers"

test.describe("E2E-8R abort a real reply", () => {
  test("Abort stops the turn and the session returns to idle", async ({ page }) => {
    await loginReal(page)
    const dir = await selectTestProject(page)
    const id = await createSessionViaApi(page, dir)
    expect(id).toBeTruthy()
    try {
      await page.goto(`/session/${id}`)
      await page.fill("textarea", "Count slowly from 1 to 50, one number per line, no other text.")
      await page.getByRole("button", { name: "Send" }).click()

      // The turn goes busy → Abort appears.
      await expect(page.getByRole("button", { name: "Abort" })).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText("working", { exact: true })).toBeVisible()

      await page.getByRole("button", { name: "Abort" }).click()

      // Back to idle promptly.
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("working", { exact: true })).toHaveCount(0)
    } finally {
      await deleteSessionViaApi(page, id!, dir)
    }
  })
})
