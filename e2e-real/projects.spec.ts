import { expect, test } from "@playwright/test"
import { loginReal, selectTestProject } from "./helpers"

test.describe("E2E-2R multi-project switching (real projects)", () => {
  test("switching scopes the session list to each worktree", async ({ page }) => {
    await loginReal(page)
    const select = page.getByTitle("Active project")
    await expect(select).toBeVisible({ timeout: 30_000 })

    const options = await select.locator("option").all()
    expect(options.length).toBeGreaterThan(1)

    const mine = await selectTestProject(page)
    const values = await select.locator("option").evaluateAll((els) => els.map((el) => el.value))
    const other = values.find((v) => v && v !== mine) ?? values[1]

    // Session lists are per-directory: counts may differ, and switching back
    // shows the same first set again (no cross-contamination).
    const inMine = await page.locator("a[href^='/session/']").count()
    await select.selectOption(other)
    await page.waitForTimeout(1_000)
    await select.selectOption(mine)
    await expect
      .poll(async () => page.locator("a[href^='/session/']").count(), { timeout: 15_000 })
      .toBe(inMine)
    console.log(`sessions in ${mine}: ${inMine}, other project: ${other}`)
    expect(select).toHaveValue(mine)
  })
})
