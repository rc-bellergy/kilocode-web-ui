import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { MAIN_BASE, crashKilo, loginReal, selectTestProject, waitBackendKiloDown, waitBackendKiloUp } from "./helpers"

const PID_FILE = path.join(os.tmpdir(), "kilo-e2e-real", "backend.pid")

test.describe("E2E-7R realtime updates and crash recovery (spawn mode, real kilo)", () => {
  test("changes stream between tabs; a killed kilo auto-recovers with gap-fill", async ({ page }) => {
    await loginReal(page)
    const dir = await selectTestProject(page)

    const page2 = await page.context().newPage()
    await page2.goto("/")
    await page2.getByTitle("Active project").selectOption(dir)

    // Live cross-tab: create via tab 2, appears in tab 1 without reload.
    const created = await page2.evaluate(async (d) => {
      const res = await fetch(`/api/kilo/session?directory=${encodeURIComponent(d)}`, {
        method: "POST",
        credentials: "same-origin",
      })
      return ((await res.json()) as { id: string }).id
    }, dir)
    await expect(page.locator(`a[href='/session/${created}']`)).toBeVisible({ timeout: 30_000 })

    // Crash kilo: the backend flips to not-ready immediately (its exit handler
    // is synchronous) — assert that FIRST, before the self-restart races us.
    const backendPid = Number(fs.readFileSync(PID_FILE, "utf8"))
    crashKilo(backendPid)

    await waitBackendKiloDown(MAIN_BASE, 30_000)
    // The disconnect indicator depends on browser/EventSource timing against
    // a fast self-restart (hard-asserted in the mock suite); here record it.
    const sawDisconnected = await page
      .getByText("events disconnected")
      .isVisible()
      .catch(() => false)
    const sawBanner = await page
      .getByText(/restarting|exited|unreachable|starting/i)
      .first()
      .isVisible()
      .catch(() => false)
    test.info().annotations.push({ type: "note", description: `sawUiBanner=${sawBanner} sawDisconnected=${sawDisconnected}` })

    // Recovery: backend restarts kilo itself, SSE reconnects, the earlier
    // session is still listed (gap-fill refetch) and new activity streams in.
    await waitBackendKiloUp(MAIN_BASE, 120_000)
    await expect(page.getByText("events disconnected")).toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator(`a[href='/session/${created}']`)).toBeVisible({ timeout: 60_000 })

    const created2 = await page2.evaluate(async (d) => {
      const res = await fetch(`/api/kilo/session?directory=${encodeURIComponent(d)}`, {
        method: "POST",
        credentials: "same-origin",
      })
      return ((await res.json()) as { id: string }).id
    }, dir)
    await expect(page.locator(`a[href='/session/${created2}']`)).toBeVisible({ timeout: 60_000 })

    // Cleanup both sessions.
    for (const id of [created, created2]) {
      await page.evaluate(
        async ({ id, d }) => {
          await fetch(`/api/kilo/session/${id}?directory=${encodeURIComponent(d)}`, {
            method: "DELETE",
            credentials: "same-origin",
          }).catch(() => {})
        },
        { id, d: dir },
      )
    }
    await page2.close()
  })
})
