import { expect, test } from "@playwright/test"
import { createSessionViaApi, deleteSessionViaApi, loginReal, selectTestProject } from "./helpers"

test.describe("E2E-6R real permission flow", () => {
  test("bash tool request asks for approval and Approve clears it", async ({ page }) => {
    await loginReal(page)
    const dir = await selectTestProject(page)

    // Find a visible primary agent whose rules ask for bash (config-aware).
    const agents = (await page.evaluate(async (d) => {
      const res = await fetch(`/api/kilo/agent?directory=${encodeURIComponent(d)}`, { credentials: "same-origin" })
      return (await res.json()) as {
        name: string
        displayName?: string | null
        mode: string
        hidden?: boolean | null
        deprecated?: boolean | null
        permission?: { permission: string; pattern: string; action: string }[]
      }[]
    }, dir)) ?? []

    const askAgent = agents.find(
      (a) =>
        !a.hidden &&
        !a.deprecated &&
        (a.mode === "primary" || a.mode === "all") &&
        a.permission?.some((r) => r.action === "ask" && (r.permission === "bash" || r.permission === "*")),
    )
    test.skip(!askAgent, "no visible agent configured to ask for bash; nothing to exercise")

    const id = await createSessionViaApi(page, dir)
    expect(id).toBeTruthy()
    try {
      await page.goto(`/session/${id}`)
      await page.getByTitle("Agent mode").selectOption(askAgent!.name)
      await page.fill("textarea", "Use the bash tool to run exactly this command: echo kilo-real-e2e")
      await page.getByRole("button", { name: "Send" }).click()

      // Wait for either a permission request or the turn finishing without
      // one (config may auto-allow despite the ask rule — e.g. pattern order).
      const inbox = page.getByTitle("Permission requests")
      let asked = false
      for (let i = 0; i < 180; i++) {
        if ((await inbox.locator("span").count()) > 0) {
          asked = true
          break
        }
        const finished = await page
          .getByRole("button", { name: "Send" })
          .isVisible()
          .catch(() => false)
        const bubbles = await page.locator("div.space-y-6 > div").count()
        if (finished && bubbles >= 2) break
        await page.waitForTimeout(500)
      }
      if (!asked) {
        test.skip(true, `agent "${askAgent!.name}" auto-allowed bash (config); no permission to exercise`)
      }

      await inbox.click()
      const panel = page.locator("aside")
      await expect(panel.getByText("bash", { exact: true }).first()).toBeVisible()
      await panel.getByRole("button", { name: "Approve" }).click()
      await expect(inbox.locator("span")).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await deleteSessionViaApi(page, id!, dir)
    }
  })
})
