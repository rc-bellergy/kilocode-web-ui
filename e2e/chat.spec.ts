import { expect, test } from "@playwright/test"
import { control, mockState } from "./mock-kilo-process"
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
    // VS Code-style Shell card: icon + "Shell · <description>", then one
    // terminal block with the highlighted command and the raw output inline.
    const card = page.locator("div.rounded-xl", { hasText: "echo mock" })
    await expect(card).toBeVisible()
    await expect(card.getByText("Shell", { exact: true })).toBeVisible()
    await expect(card.getByText("$", { exact: true })).toBeVisible()
    await expect(card.getByText("echo mock").first()).toBeVisible()
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

  test("suggest card actions send their prompt as a new user message", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "done +SUGGEST")

    const card = page.getByTestId("suggest-tool-card")
    await expect(card).toBeVisible()
    await expect(card.getByText(/consider an independent review pass/)).toBeVisible()

    // Buttons unlock only once the suggesting turn has finished (session idle).
    const review = card.getByRole("button", { name: /review changes/i })
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible()
    await review.click()

    // The action's prompt is sent verbatim as a new user message.
    await expect
      .poll(async () =>
        (await mockState()).prompts.some((p) => p.body.parts.some((x) => x.text === "/review uncommitted")),
      )
      .toBe(true)
    // The used action is marked sent and disabled (the follow-up turn's user
    // message keeps it disabled even after a reload).
    await expect(review).toBeDisabled()
    await expect(review.getByText("sent")).toBeVisible()
    await expect(card.getByRole("button", { name: /run tests/i })).toBeEnabled()
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
