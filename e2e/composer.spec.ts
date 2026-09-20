import { expect, test } from "@playwright/test"
import { mockState } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetFavourites, resetMock, sendPrompt, setFavourites } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await resetFavourites()
  await login(page)
})

test.describe("E2E-5 composer settings", () => {
  test("mode/model selections persist in localStorage across reloads and reach the prompt", async ({ page }) => {
    // The dropdown only lists favourites — seed one before opening the session.
    await setFavourites([{ providerID: "mock-provider", modelID: "mock-large", name: "Mock Large", addedAt: Date.now() }])

    const sessionID = await createMockSession()
    await openSession(page, sessionID)

    const modelSelect = page.getByTitle("Model")
    // Favourites load asynchronously after navigation; wait for ours.
    await expect(modelSelect.locator('option[value="mock-provider/mock-large"]')).toBeAttached()
    // Only default + the favourite + Manage are offered (no full catalogue;
    // the dash row is the disabled separator option).
    const values = await modelSelect.locator("option").evaluateAll((els) => els.map((el) => el.value))
    expect(values.filter((v) => v && v !== "__manage__" && !v.startsWith("─"))).toEqual(["mock-provider/mock-large"])

    await page.getByTitle("Agent mode").selectOption("ask")
    await modelSelect.selectOption("mock-provider/mock-large")

    const stored = await page.evaluate(() => ({
      agent: localStorage.getItem("kilo-web.agent"),
      model: localStorage.getItem("kilo-web.model"),
    }))
    expect(stored.agent).toBe("ask")
    expect(JSON.parse(stored.model!)).toEqual({ providerID: "mock-provider", modelID: "mock-large" })

    // Reload: the selections survive.
    await page.reload()
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible()
    await expect(page.getByTitle("Agent mode")).toHaveValue("ask")
    await expect(page.getByTitle("Model")).toHaveValue("mock-provider/mock-large")

    // They are sent with the prompt.
    await sendPrompt(page, "with settings")
    await expect(page.getByText("Mock reply: done.")).toBeVisible({ timeout: 20_000 })
    const { prompts } = await mockState()
    const last = prompts.at(-1)!
    expect(last.body.agent).toBe("ask")
    expect(last.body.model).toEqual({ providerID: "mock-provider", modelID: "mock-large" })
  })

  test("a stored non-favourite model still renders and sends (current · X)", async ({ page }) => {
    await page.evaluate(() =>
      localStorage.setItem("kilo-web.model", JSON.stringify({ providerID: "mock-provider", modelID: "mock-mini" })),
    )
    const sessionID = await createMockSession()
    await openSession(page, sessionID)

    const modelSelect = page.getByTitle("Model")
    await expect(modelSelect).toHaveValue("mock-provider/mock-mini")
    // The label upgrades from modelID to the live model name once providers load.
    await expect(modelSelect.locator("option", { hasText: "current" })).toHaveText("current · Mock Mini")

    await sendPrompt(page, "stale pick")
    await expect(page.getByText("Mock reply: done.")).toBeVisible({ timeout: 20_000 })
    const { prompts } = await mockState()
    expect(prompts.at(-1)!.body.model).toEqual({ providerID: "mock-provider", modelID: "mock-mini" })
  })
})
