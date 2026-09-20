import { expect, test } from "@playwright/test"
import { control, mockState } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetMock, sendPrompt } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await login(page)
  await control("/__control/delay", { ms: 40 })
})

test.describe("E2E-8 agent questions (question.v2)", () => {
  test("inline form renders from the question tool; preset reply reaches kilo and the card flips to answered", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "pick a database +Q")

    // The interactive form appears inline in the transcript.
    const form = page.locator("[data-question-id]")
    await expect(form).toBeVisible({ timeout: 10_000 })
    await expect(form.getByText("Which database should the app use?")).toBeVisible()
    await expect(form.getByRole("radio", { name: /PostgreSQL/ })).toBeVisible()
    await expect(form.getByRole("radio", { name: /SQLite/ })).toBeVisible()

    // Submit is disabled until an option is picked.
    await expect(form.getByRole("button", { name: "Submit" })).toBeDisabled()

    await form.getByRole("radio", { name: /PostgreSQL/ }).check()
    await form.getByRole("button", { name: "Submit" }).click()

    // kilo received answers: one array of selected labels per question.
    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)).toMatchObject({
      answers: [["PostgreSQL (Recommended)"]],
      rejected: false,
    })

    // The tool card shows the answered state with the chosen label.
    const card = page.getByTestId("question-tool-card")
    await expect(card.getByText("answered")).toBeVisible({ timeout: 10_000 })
    await expect(card.getByText("PostgreSQL (Recommended)")).toBeVisible()

    // The gated turn completes after the answer.
    await expect(page.getByText("Mock reply: done.")).toBeVisible({ timeout: 15_000 })
  })

  test("custom typed answer is submitted as the label", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "pick a database +Q")

    const form = page.locator("[data-question-id]")
    await expect(form).toBeVisible({ timeout: 10_000 })
    await form.getByRole("radio", { name: /Type your own answer/i }).check()
    await form.getByTestId("custom-answer").fill("MariaDB")
    await form.getByRole("button", { name: "Submit" }).click()

    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)?.answers).toEqual([["MariaDB"]])
  })

  test("multiple-select questions submit every checked label", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "scope +Q +QMULTI")

    const form = page.locator("[data-question-id]")
    await expect(form.getByText("Which features should land first?")).toBeVisible({ timeout: 10_000 })
    await form.getByRole("checkbox", { name: "Auth" }).check()
    await form.getByRole("checkbox", { name: "Billing" }).check()
    await form.getByRole("button", { name: "Submit" }).click()

    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)?.answers).toEqual([["Auth", "Billing"]])
  })

  test("custom: false hides the custom answer option", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "ship it +Q +QNOCUSTOM")

    const form = page.locator("[data-question-id]")
    await expect(form.getByText("Ship on Friday?")).toBeVisible({ timeout: 10_000 })
    await expect(form.getByText(/Type your own answer/)).toHaveCount(0)
  })

  test("dismiss rejects the question and the card shows the dismissed state", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await sendPrompt(page, "pick a database +Q")

    const form = page.locator("[data-question-id]")
    await expect(form).toBeVisible({ timeout: 10_000 })
    await form.getByRole("button", { name: "Dismiss" }).click()

    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)).toMatchObject({ answers: null, rejected: true })

    const card = page.getByTestId("question-tool-card")
    await expect(card.getByText("dismissed", { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test("standalone question (no tool part) renders above the composer", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)

    const request = (await control("/__control/question", { sessionID })) as { id: string }

    // No transcript part exists, so the fallback form shows above the composer.
    const form = page.locator("[data-question-id]")
    await expect(form).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("question-tool-card")).toHaveCount(0)

    await form.getByRole("radio", { name: /SQLite/ }).check()
    await form.getByRole("button", { name: "Submit" }).click()

    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)).toMatchObject({ requestID: request.id, answers: [["SQLite"]] })
    await expect(page.locator("[data-question-id]")).toHaveCount(0)
  })

  test("question in another session badges the inbox and is answerable from the drawer", async ({ page }) => {
    await createMockSession()
    const other = await createMockSession()
    await page.goto("/")

    await control("/__control/question", { sessionID: other })

    const inboxButton = page.getByTitle("Permission requests")
    await expect(inboxButton.locator("span", { hasText: "1" })).toBeVisible({ timeout: 10_000 })

    await inboxButton.click()
    const panel = page.locator("aside")
    const form = panel.locator("[data-question-id]")
    await expect(form.getByText("Which database should the app use?")).toBeVisible()

    await form.getByRole("radio", { name: /PostgreSQL/ }).check()
    await form.getByRole("button", { name: "Submit" }).click()

    const { questionReplies } = await mockState()
    expect(questionReplies.at(-1)?.answers).toEqual([["PostgreSQL (Recommended)"]])
    await expect(inboxButton.locator("span", { hasText: "1" })).toHaveCount(0)
  })
})
