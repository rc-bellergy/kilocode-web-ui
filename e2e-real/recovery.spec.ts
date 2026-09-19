import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import {
  MAIN_BASE,
  crashKilo,
  loginReal,
  selectTestProject,
  startBackend,
  startKiloServe,
  waitBackendKiloDown,
  waitBackendKiloUp,
  waitKiloReady,
  waitKiloServeDirect,
  waitPort,
} from "./helpers"

const PID_FILE = path.join(os.tmpdir(), "kilo-e2e-real", "backend.pid")

test.describe("E2E-9R automatic recovery", () => {
  test("spawn mode: repeated kilo crashes are restarted automatically (×3)", async ({ page }) => {
    await loginReal(page)
    await selectTestProject(page)
    const backendPid = Number(fs.readFileSync(PID_FILE, "utf8"))

    for (let i = 1; i <= 3; i++) {
      crashKilo(backendPid)
      // Backend deterministically reports not-ready, then self-restarts kilo.
      await waitBackendKiloDown(MAIN_BASE, 30_000)
      await waitBackendKiloUp(MAIN_BASE, 120_000)
      console.log(`recovery cycle ${i}/3 ok`)
    }
    // SSE is live again after the final recovery.
    await expect(page.getByText("events disconnected")).toHaveCount(0, { timeout: 90_000 })
  })

  test("attached mode: target restart triggers automatic re-attach (P0-1)", async ({ page }) => {
    // Own real kilo serve + own attached backend, isolated from the main one.
    // NB: avoid URL-spec "bad ports" (e.g. 4190/sieve) — fetch refuses them.
    const kilo = startKiloServe(4290)
    try {
      await waitKiloServeDirect(kilo.base, 60_000, kilo.output)
      const backend = startBackend({ port: 3214, attach: kilo.base })
      try {
        await waitPort(backend.base, 30_000)
        await waitKiloReady(backend.base)
        await loginReal(page, backend.base)
        const dir = await selectTestProject(page)

        // Kill the TARGET kilo: the attached backend detects it (probe).
        kilo.child.kill("SIGKILL")
        await waitBackendKiloDown(backend.base, 30_000)

        // Restart the target on the same port: the backend re-attaches by
        // itself and the UI keeps working (create/delete through the proxy).
        const kilo2 = startKiloServe(4290)
        try {
          await waitKiloServeDirect(kilo2.base, 60_000, kilo2.output)
          await waitBackendKiloUp(backend.base, 60_000)
          await expect(page.getByText("events disconnected")).toHaveCount(0, { timeout: 60_000 })

          const created = await page.evaluate(async (d) => {
            const res = await fetch(`/api/kilo/session?directory=${encodeURIComponent(d)}`, {
              method: "POST",
              credentials: "same-origin",
            })
            return ((await res.json()) as { id: string }).id
          }, dir)
          await expect(page.locator(`a[href='/session/${created}']`)).toBeVisible({ timeout: 60_000 })
          await page.evaluate(
            async ({ id, d }) => {
              await fetch(`/api/kilo/session/${id}?directory=${encodeURIComponent(d)}`, {
                method: "DELETE",
                credentials: "same-origin",
              }).catch(() => {})
            },
            { id: created, d: dir },
          )
        } finally {
          await kilo2.stop()
        }
      } finally {
        await backend.stop()
      }
    } finally {
      await kilo.stop()
    }
  })
})
