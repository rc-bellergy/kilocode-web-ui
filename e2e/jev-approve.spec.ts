import { expect, test, type Page } from "@playwright/test"
import { control, mockState } from "./mock-kilo-process"
import { createMockSession, login, resetMock } from "./helpers"

/** Seed the Jev toggles before any navigation (feature is default-off). */
async function seedJev(page: Page, opts: { level?: "low" | "low+medium" } = {}) {
  await page.addInitScript((level) => {
    localStorage.setItem("kilo-web.jev-autoapprove", "1")
    if (level) localStorage.setItem("kilo-web.jev-auto-level", level)
  }, opts.level ?? null)
}

/** Emit a command permission through the mock and return its id. */
async function askCommand(sessionID: string, command: string): Promise<string> {
  const request = (await control("/__control/permission", {
    sessionID,
    permission: "bash",
    metadata: { command },
  })) as { id: string }
  return request.id
}

test.beforeEach(async () => {
  await resetMock()
})

test.describe("Jev auto-approve (JEV_MOCK)", () => {
  test("low-risk command is auto-approved once, inbox clears, toast shows", async ({ page }) => {
    await seedJev(page)
    const sessionID = await createMockSession()
    await login(page)

    const requestID = await askCommand(sessionID, "gh auth status")
    const inboxButton = page.getByTitle("Permission requests")

    await expect
      .poll(async () => (await mockState()).replies.at(-1))
      .toMatchObject({ requestID, reply: "once" })
    await expect(inboxButton.locator("span")).toHaveCount(0)
    await expect(page.getByText("Auto-approved by Jev (low risk)")).toBeVisible()
  })

  test("blocklist hit stays for the user with a red badge", async ({ page }) => {
    await seedJev(page)
    const sessionID = await createMockSession()
    await login(page)

    const requestID = await askCommand(sessionID, "sudo systemctl restart foo")
    const inboxButton = page.getByTitle("Permission requests")
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible()

    await inboxButton.click()
    const panel = page.locator("aside")
    await expect(panel.getByText("Blocked by safety list (sudo) — needs your approval")).toBeVisible()

    const replies = (await mockState()).replies
    expect(replies).toEqual([])

    // Manual approval still works and dismisses the card.
    await panel.getByRole("button", { name: "Approve" }).click()
    await expect
      .poll(async () => (await mockState()).replies.at(-1))
      .toMatchObject({ requestID, reply: "once" })
    await expect(inboxButton.locator("span")).toHaveCount(0)
  })

  test("Low only mode keeps medium-risk commands; switching back auto-approves", async ({ page }) => {
    await seedJev(page, { level: "low" })
    const sessionID = await createMockSession()
    await login(page)

    const requestID = await askCommand(sessionID, "gh auth switch -u x && gh auth status")
    const inboxButton = page.getByTitle("Permission requests")
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible()

    await inboxButton.click()
    const panel = page.locator("aside")
    await expect(panel.getByText("Jev: medium risk — needs your approval")).toBeVisible({ timeout: 10_000 })
    const replies = (await mockState()).replies
    expect(replies).toEqual([])

    // Widen to Low + Medium: the stored verdict becomes auto-approvable.
    await page.getByLabel("Auto-approve level").selectOption("low+medium")
    await expect
      .poll(async () => (await mockState()).replies.at(-1))
      .toMatchObject({ requestID, reply: "once" })
    await expect(inboxButton.locator("span")).toHaveCount(0)
  })

  test("toggle off means no classification at all", async ({ page }) => {
    const sessionID = await createMockSession()
    await login(page)

    await askCommand(sessionID, "gh auth status")
    const inboxButton = page.getByTitle("Permission requests")
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible()

    await expect(page.getByLabel("Jev auto-approve")).toHaveAttribute("aria-pressed", "false")
    await inboxButton.click()
    const panel = page.locator("aside")
    await expect(panel.getByText("gh auth status")).toBeVisible()
    await expect(panel.getByText(/Jev/)).toHaveCount(0)

    const replies = (await mockState()).replies
    expect(replies).toEqual([])
  })

  test("manual approval during classification wins; no double reply", async ({ page }) => {
    await seedJev(page)
    const sessionID = await createMockSession()
    await login(page)

    const inboxButton = page.getByTitle("Permission requests")
    await inboxButton.click()
    const panel = page.locator("aside")

    // slow-marker delays the mock classifier by 1500ms.
    const requestID = await askCommand(sessionID, "echo slow-marker && ls")
    await expect(panel.getByText("Jev assessing…")).toBeVisible()

    await panel.getByRole("button", { name: "Approve" }).click()
    await expect(inboxButton.locator("span")).toHaveCount(0)

    // Classification resolves after the manual reply: dropped silently.
    await page.waitForTimeout(2_000)
    const replies = (await mockState()).replies
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ requestID, reply: "once" })
    await expect(page.getByText(/Auto-approved by Jev/)).toHaveCount(0)
  })
})
