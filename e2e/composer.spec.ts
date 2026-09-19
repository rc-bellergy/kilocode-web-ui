import { expect, test } from "@playwright/test"
import { mockState } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetMock, sendPrompt } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
})

test.describe("E2E-5 composer settings", () => {
  test("mode/model selections persist in localStorage across reloads and reach the prompt", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)

    await page.getByTitle("Agent mode").selectOption("ask")
    await page.getByTitle("Model").selectOption("mock-provider/mock-large")

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
})
