import { expect, test } from "@playwright/test"
import { loginReal } from "./helpers"

test.describe("E2E-10R notifications (real backend)", () => {
  test("bell toggle handles the browser's real permission state and persists", async ({ page }) => {
    await loginReal(page)

    const permission = await page.evaluate(() => ("Notification" in window ? Notification.permission : "unsupported"))
    await page.getByTitle(/Enable notifications/).click()

    // Persisted regardless of the permission outcome…
    await expect
      .poll(async () => await page.evaluate(() => localStorage.getItem("kilo-web.notify")), { timeout: 10_000 })
      .toContain('"enabled":true')

    // …and the UI reacts to the actual state without crashing.
    if (permission === "denied") {
      await expect(page.getByText(/Notifications blocked/i)).toBeVisible({ timeout: 10_000 })
    }

    // Title badge plumbing is alive (base title, no crash on update).
    const title = await page.title()
    expect(title.length).toBeGreaterThan(0)

    test.info().annotations.push({
      type: "note",
      description:
        "OS-level notification popup/click and iOS-home-screen delivery cannot be automated (headless Chromium " +
        "cannot receive real OS notifications; clicking an OS notification is system UI). Verify those manually.",
    })
  })
})
