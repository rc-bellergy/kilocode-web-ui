import { expect, test } from "@playwright/test"
import { createSessionViaApi, deleteSessionViaApi, loginReal, selectTestProject } from "./helpers"

test.describe("E2E-5R composer settings (real agents/models)", () => {
  test("mode/model picks persist across reloads", async ({ page }) => {
    await loginReal(page)
    const dir = await selectTestProject(page)
    const id = await createSessionViaApi(page, dir)
    expect(id).toBeTruthy()
    try {
      await page.goto(`/session/${id}`)

      const modeSelect = page.getByTitle("Agent mode")
      const modelSelect = page.getByTitle("Model")

      // Wait for agents/models to load, then pick real options (not defaults).
      await expect
        .poll(async () => await modeSelect.locator("option").count(), { timeout: 30_000 })
        .toBeGreaterThan(1)
      const modeOptions = await modeSelect.locator("option").allTextContents()
      const pick = modeOptions.find((t) => t && t !== "default mode" && /ask/i.test(t)) ?? modeOptions.find((t) => t && t !== "default mode")
      expect(pick).toBeTruthy()
      await modeSelect.selectOption({ label: pick! })

      await expect
        .poll(async () => await modelSelect.locator("option").count(), { timeout: 30_000 })
        .toBeGreaterThan(1)
      const modelValues = await modelSelect.locator("option").evaluateAll((els) => els.map((el) => el.value))
      const nonDefault = modelValues.find((v) => v)
      expect(nonDefault).toBeTruthy()
      await modelSelect.selectOption(nonDefault!)

      await page.reload()
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(async () => await modelSelect.locator("option").count(), { timeout: 30_000 })
        .toBeGreaterThan(1)
      await expect(modeSelect).toHaveValue(await page.evaluate(() => localStorage.getItem("kilo-web.agent") ?? ""))
      const storedModel = JSON.parse((await page.evaluate(() => localStorage.getItem("kilo-web.model")))!) as {
        providerID: string
        modelID: string
      }
      const expected = `${storedModel.providerID}/${encodeURIComponent(storedModel.modelID)}`
      const actualOptions = await modelSelect.locator("option").evaluateAll((els) => els.map((el) => el.value))
      console.log("model expected:", expected, "stored:", JSON.stringify(storedModel), "options:", actualOptions.slice(0, 6))
      await expect(modelSelect).toHaveValue(expected)

      // "default" option clears the stored pick.
      await modeSelect.selectOption("")
      await expect(modeSelect).toHaveValue("")
      expect(await page.evaluate(() => localStorage.getItem("kilo-web.agent"))).toBeNull()
    } finally {
      await deleteSessionViaApi(page, id!, dir)
    }
  })
})
