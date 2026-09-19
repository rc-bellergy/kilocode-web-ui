import { expect, test } from "@playwright/test"
import { control } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetMock, sendPrompt } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
  await control("/__control/delay", { ms: 60 })
})

test.describe("E2E-4 chat transcript", () => {
  test("streams text in increments (message.part.delta), then completes", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "hello")

    // While streaming, partial text must appear before the final snapshot.
    let sawPartial = false
    for (let i = 0; i < 100; i++) {
      const body = await page.locator("main").innerText()
      if (body.includes("Mock reply:") && !body.includes("done.")) sawPartial = true
      if (body.includes("Mock reply: done.")) break
      await page.waitForTimeout(50)
    }
    await expect(page.getByText("Mock reply: done.")).toBeVisible()
    expect(sawPartial).toBe(true)
  })

  test("reasoning collapses into a details block", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "hello")
    await expect(page.getByText("Reasoning", { exact: true })).toBeVisible()
    await expect(page.getByText(/Mock reasoning about the request/)).toBeAttached()
  })

  test("tool card renders the completed state with output", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "run a tool +TOOL")
    const card = page.locator("div.rounded-xl", { hasText: "echo mock" })
    await expect(card).toBeVisible()
    await expect(card.getByText("completed")).toBeVisible()
    await card.getByRole("button", { name: /output/i }).click()
    await expect(card.getByText("mock tool output")).toBeVisible()
  })

  test("tool error state renders the error output", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "boom +TOOLERR")
    await expect(page.getByText("mock tool failure")).toBeVisible()
  })

  test("file and subtask parts render", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "assets +FILE +SUBTASK")
    await expect(page.getByText("chart.png")).toBeVisible()
    await expect(page.getByText("subtask · unit-test")).toBeVisible()
    await expect(page.getByText("Delegates the sub-thing")).toBeVisible()
  })

  test("markdown renders and <script> is sanitized away (XSS)", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "nasty +XSS")
    await expect(page.locator(".md strong", { hasText: "bold" })).toBeVisible()
    const scripts = await page.locator(".md script").count()
    expect(scripts).toBe(0)
  })

  test("streaming output keeps the view scrolled to the bottom (P0-4)", async ({ page }) => {
    await control("/__control/delay", { ms: 15 })
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "essay +LONG")

    // Long content must overflow the scroll container.
    await expect(page.getByText(/This is a long streaming sentence/).first()).toBeVisible()
    await expect
      .poll(async () => (await page.locator("main").innerText()).includes("testing. done."), { timeout: 30_000 })
      .toBe(true)

    const distance = await page.evaluate(() => {
      const el = document.querySelector("main div.overflow-y-auto") as HTMLElement | null
      if (!el) return Number.NaN
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    expect(distance).toBeLessThan(120)
  })
})
