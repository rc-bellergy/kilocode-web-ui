import { expect, test } from "@playwright/test"
import { REAL_PASSWORD, loginReal, startBackend, waitKiloReady, waitPort, waitPortStopped } from "./helpers"

test.describe("E2E-1R password login", () => {
  test("wrong password shows an error; correct password enters the dashboard", async ({ page }) => {
    await page.goto("/")
    await page.fill("#password", "definitely-wrong")
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page.getByText("Invalid password")).toBeVisible()
    await page.fill("#password", REAL_PASSWORD)
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible()
  })

  test("backend restart invalidates all sessions (per-boot HMAC key)", async ({ page }) => {
    // Dedicated backend so the main one keeps serving other tests.
    const a = startBackend({ port: 3212 })
    await waitPort(a.base, 30_000)
    await waitKiloReady(a.base)
    await loginReal(page, a.base)

    // Kill and restart on the same port: fresh signing key.
    await a.stop()
    await waitPortStopped(a.base)
    const b = startBackend({ port: 3212 })
    await waitPort(b.base, 30_000)
    await waitKiloReady(b.base)

    await page.reload()
    await expect(page).toHaveURL(/\/login$/)
    await b.stop()
  })

  test("COOKIE_SECURE=1 marks the session cookie Secure", async () => {
    const backend = startBackend({ port: 3213, cookieSecure: true })
    await waitPort(backend.base, 30_000)
    const res = await fetch(`${backend.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: REAL_PASSWORD }),
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("kw_session=")
    expect(setCookie).toContain("Secure")
    await backend.stop()
  })

  test("health is anonymous-minimal against real kilo", async () => {
    const res = await fetch("http://127.0.0.1:3210/api/health")
    const health = (await res.json()) as { kilo: Record<string, unknown> }
    expect(Object.keys(health.kilo)).toEqual(["ready"])
    expect(health.kilo.ready).toBe(true)
  })
})
