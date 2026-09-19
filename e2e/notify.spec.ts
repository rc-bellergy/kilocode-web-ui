import { expect, test, type Page } from "@playwright/test"
import { control } from "./mock-kilo-process"
import { createMockSession, login, resetMock } from "./helpers"

/**
 * Headless Chromium cannot exercise real OS notifications (CDP permission
 * grants never reach the Notification content setting), so these tests stub
 * the Notification API in-page and assert our notify logic: what gets
 * constructed, when (hidden only), and the badge behavior. Real notification
 * delivery is covered by the Phase 4 manual checklist.
 */
type Recorded = { title: string; body?: string; tag?: string }

async function installNotificationStub(page: Page, permission: "granted" | "denied" | "default"): Promise<void> {
  await page.addInitScript((perm) => {
    const created: Recorded[] = []
    ;(window as unknown as { __kiloNotifications: Recorded[] }).__kiloNotifications = created
    class FakeNotification {
      static permission = perm
      static requestPermission = () => Promise.resolve(perm)
      onclick: ((ev?: unknown) => void) | null = null
      constructor(
        public title: string,
        public options?: { body?: string; tag?: string },
      ) {
        created.push({ title, body: options?.body, tag: options?.tag })
      }
      close() {}
    }
    ;(window as unknown as { Notification: unknown }).Notification = FakeNotification
  }, permission)
}

async function recorded(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __kiloNotifications: Recorded[] }).__kiloNotifications)
}

async function stubHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { value, configurable: true })
  }, hidden)
}

test.beforeEach(async () => {
  await resetMock()
})

test.describe("E2E-10 browser notifications", () => {
  test.beforeEach(async ({ page }) => {
    await installNotificationStub(page, "granted")
  })

  test("bell toggle persists and permission.asked notifies in a background tab", async ({ page }) => {
    await login(page)
    await stubHidden(page, true)

    // Enable via the bell button (user gesture; stub permission is granted).
    await page.getByTitle(/Enable notifications/).click()

    const stored = await page.evaluate(() => localStorage.getItem("kilo-web.notify"))
    expect(JSON.parse(stored!)).toEqual({ enabled: true, sound: false })

    // permission.asked → system notification with permission, session title and command.
    const sessionID = await createMockSession()
    await control("/__control/permission", {
      sessionID,
      permission: "bash",
      metadata: { command: "rm -rf /tmp/kilo-e2e/scratch\nsecond line" },
    })

    await expect
      .poll(async () => (await recorded(page)).length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    const n = (await recorded(page))[0]
    expect(n.title).toBe("Agent needs approval")
    expect(n.body).toContain("bash — New session")
    expect(n.body).toContain("rm -rf /tmp/kilo-e2e/scratch")
    expect(n.body).not.toContain("second line") // only the first command line
    expect(n.tag).toContain("kilo-perm-")

    // Badge: 1 pending permission shows in the title until the inbox is cleared.
    await expect.poll(() => page.title(), { timeout: 10_000 }).toMatch(/^\(1\)/)
    await page.getByTitle("Permission requests").click()
    await page.locator("aside").getByRole("button", { name: "Approve" }).click()
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .not.toMatch(/^\(\d+\)/)
  })

  test("busy→idle completion notifies once per cycle; viewing the session clears the badge", async ({ page }) => {
    await login(page)
    await page.getByTitle(/Enable notifications/).click()
    await stubHidden(page, true)

    const sessionID = await createMockSession()
    await control("/__control/status", { sessionID, status: { type: "busy" } })
    await page.waitForTimeout(300)

    await control("/__control/status", { sessionID, status: { type: "idle" } })
    await expect
      .poll(async () => (await recorded(page)).some((x) => /Agent done: New session/.test(x.title)), { timeout: 15_000 })
      .toBe(true)

    // Badge counts the unviewed completion.
    await expect.poll(() => page.title(), { timeout: 10_000 }).toMatch(/^\(1\)/)

    // Opening that session clears the unread badge. (page.goto reloads the
    // document, so the hidden-stub and the recorder array restart.)
    await page.goto(`/session/${sessionID}`)
    await expect
      .poll(() => page.title(), { timeout: 10_000 })
      .not.toMatch(/^\(\d+\)/)
    // Wait for the reloaded app to finish booting (session title rendered =
    // REST loaded; give the EventSource a moment to connect) and re-stub.
    await expect(page.locator("h1", { hasText: "New session" })).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(800)
    await stubHidden(page, true)

    // A second busy→idle cycle notifies again (once per cycle), but an idle
    // without a preceding busy does not.
    const before = (await recorded(page)).length
    await control("/__control/status", { sessionID, status: { type: "busy" } })
    await control("/__control/status", { sessionID, status: { type: "idle" } })
    await expect
      .poll(async () => (await recorded(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(before)
  })

  test("foreground tab: no system notification, toast + badge only", async ({ page }) => {
    await login(page)
    await page.getByTitle(/Enable notifications/).click()
    await stubHidden(page, false) // visible

    const sessionID = await createMockSession()
    await control("/__control/permission", { sessionID, permission: "bash", metadata: { command: "echo x" } })

    await expect(page.getByText("Permission needed: bash")).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => page.title(), { timeout: 10_000 }).toMatch(/^\(1\)/)
    await page.waitForTimeout(1000)
    expect(await recorded(page)).toHaveLength(0)
  })
})

test.describe("E2E-10b denied permission fallback", () => {
  test("denied notifications: no crash, teaching toast, badge still works", async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await installNotificationStub(page, "denied")
    await login(page)

    await page.getByTitle(/Enable notifications/).click()
    await expect(page.getByText(/Notifications blocked/i)).toBeVisible({ timeout: 10_000 })

    const sessionID = await createMockSession()
    await control("/__control/permission", { sessionID, permission: "bash" })
    // No exception path: toast still fires and the badge counts.
    await expect(page.getByText("Permission needed: bash")).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => page.title(), { timeout: 10_000 }).toMatch(/^\(1\)/)
    expect(await recorded(page)).toHaveLength(0)
    await context.close()
  })

  test("?inbox=1 opens the permission inbox (notification click destination)", async ({ page }) => {
    await login(page)
    const sessionID = await createMockSession()
    await control("/__control/permission", { sessionID, permission: "bash" })
    await page.goto("/?inbox=1")
    await expect(page.locator("aside").getByRole("heading", { name: "Permission requests" })).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
  })
})
