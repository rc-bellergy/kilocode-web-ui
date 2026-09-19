import { expect, type Page } from "@playwright/test"
import { control } from "./mock-kilo-process"

export const PASSWORD = "kilo"
export const PROJECT_A = "/tmp/kilo-e2e/project-a"
export const PROJECT_B = "/tmp/kilo-e2e/project-b"

export async function login(page: Page): Promise<void> {
  await page.goto("/")
  await expect(page).toHaveURL(/\/login$/)
  await page.fill("#password", PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible()
}

export async function resetMock(): Promise<void> {
  await control("/__control/reset", {})
}

/** Create a session through the mock and return its id. */
export async function createMockSession(directory = PROJECT_A): Promise<string> {
  const session = (await control("/__control/create-session", { directory })) as { id: string }
  return session.id
}

export async function openSession(page: Page, sessionID: string): Promise<void> {
  await page.goto(`/session/${sessionID}`)
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible()
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.fill("textarea", text)
  await page.getByRole("button", { name: "Send" }).click()
}
