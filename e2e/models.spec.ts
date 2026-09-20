import { expect, test } from "@playwright/test"
import { createMockSession, login, openSession, PROJECT_A, PROJECT_B, resetFavourites, resetMock } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
  await resetFavourites()
  await login(page)
})

test.describe("E2E-9 /models favourites", () => {
  test("starring a model keeps it across reloads; unstarring removes it", async ({ page }) => {
    await page.goto("/models")
    await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Star Mock Large" }).click()

    const favourites = page.getByRole("region", { name: "Favourites" })
    await expect(favourites.getByText("Mock Large")).toBeVisible()

    // Survives a reload (server-side storage).
    await page.reload()
    await expect(page.getByRole("region", { name: "Favourites" }).getByText("Mock Large")).toBeVisible()

    await page.getByRole("region", { name: "Favourites" }).getByRole("button", { name: "Unstar Mock Large" }).click()
    await expect(page.getByRole("region", { name: "Favourites" })).not.toContainText("Mock Large")
    await expect(page.getByRole("button", { name: "Star Mock Large" })).toBeVisible()
  })

  test("search filters models across name, id and provider", async ({ page }) => {
    await page.goto("/models")
    const all = page.getByRole("region", { name: "All models" })
    await expect(all.getByText("Mock Tiny")).toBeVisible()
    await expect(all.getByText("Alt One")).toBeVisible()

    await page.getByLabel("Search models").fill("alt")
    await expect(all.getByText("Mock Tiny")).toHaveCount(0)
    await expect(all.getByText("Alt One")).toBeVisible()

    await page.getByLabel("Search models").fill("mock-large")
    await expect(all.getByText("Alt One")).toHaveCount(0)
    await expect(all.getByText("Mock Large")).toBeVisible()
  })

  test("a favourite missing from the current project shows the badge and is hidden in the composer", async ({
    page,
  }) => {
    // project-a sees both providers; star a model only available there.
    await page.goto("/models")
    await page.getByRole("button", { name: "Star Alt One" }).click()
    await expect(page.getByRole("region", { name: "Favourites" }).getByText("Alt One")).toBeVisible()

    // Switch to project-b (mock-alt is not offered there) and reopen /models
    // via the SPA header link so the project scope survives the navigation.
    await page.goto("/")
    await page.getByTitle("Active project").selectOption(PROJECT_B)
    await page.getByRole("link", { name: "Models" }).click()
    await expect(page).toHaveURL(/\/models$/)
    const favourites = page.getByRole("region", { name: "Favourites" })
    await expect(favourites.getByText("Alt One")).toBeVisible()
    await expect(favourites.getByText("not in this project")).toBeVisible()

    // The composer dropdown for a project-b session omits it. Stay inside the
    // SPA (a full reload re-boots the directory fallback to project-a): the
    // session.created event lands on the still-connected project-b stream.
    const sessionB = await createMockSession(PROJECT_B)
    await page.getByRole("link", { name: "Back to sessions" }).click()
    await expect(page).toHaveURL(/\/$/)
    const modelSelect = page.getByTitle("Model")
    await page.getByRole("link", { name: /New session -/ }).first().click()
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible()
    // Project-b providers exclude mock-alt, so the favourite cannot be picked.
    await expect
      .poll(async () => modelSelect.locator("option").evaluateAll((els) => els.map((el) => el.value)))
      .not.toContain("mock-alt/alt-one")

    // Back in project-a it is selectable and sent with the prompt.
    await page.goto("/")
    await page.getByTitle("Active project").selectOption(PROJECT_A)
    const sessionA = await createMockSession(PROJECT_A)
    await openSession(page, sessionA)
    await expect(modelSelect.locator('option[value="mock-alt/alt-one"]')).toBeAttached()
    await modelSelect.selectOption("mock-alt/alt-one")
    await page.fill("textarea", "alt model pick")
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.getByText("Mock reply: done.")).toBeVisible({ timeout: 20_000 })
  })

  test("Manage models… in the composer navigates to /models", async ({ page }) => {
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await page.getByTitle("Model").selectOption("__manage__")
    await expect(page).toHaveURL(/\/models$/)
  })
})
