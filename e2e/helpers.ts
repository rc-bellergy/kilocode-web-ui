import { expect, type Page } from "@playwright/test"
import { BACKEND_URL, control } from "./mock-kilo-process"

export const PASSWORD = "kilo"
export const PROJECT_A = "/tmp/kilo-e2e/project-a"
export const PROJECT_B = "/tmp/kilo-e2e/project-b"

export interface E2EFavourite {
  providerID: string
  modelID: string
  name?: string
  addedAt: number
}

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

/** Replace the server-side favourites list through the REST API. */
export async function setFavourites(list: E2EFavourite[]): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = res.headers.get("set-cookie")!.split(";")[0]
  const put = await fetch(`${BACKEND_URL}/api/favourites`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ favourites: list }),
  })
  if (!put.ok) throw new Error(`setFavourites failed: ${put.status}`)
}

export async function resetFavourites(): Promise<void> {
  await setFavourites([])
}

/** Create a session through the mock and return its id. */
export async function createMockSession(directory = PROJECT_A): Promise<string> {
  const session = (await control("/__control/create-session", { directory })) as { id: string }
  return session.id
}

export async function openSession(page: Page, sessionID: string): Promise<void> {
  await page.goto(`/session/${sessionID}`)
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible()
  // The composer renders before the event stream is established; sending or
  // control-emitting too early can lose project-scoped events. Wait for the
  // real upstream connection (server.connected) before the test proceeds.
  await expect(page.locator('header[data-sse-state="connected"]')).toBeVisible({ timeout: 15_000 })
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.fill("textarea", text)
  await page.getByRole("button", { name: "Send" }).click()
}
