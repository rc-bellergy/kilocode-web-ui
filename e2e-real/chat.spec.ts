import { expect, test } from "@playwright/test"
import { createSessionViaApi, deleteSessionViaApi, loginReal } from "./helpers"

/** Pick the project with the fewest sessions (minimal memory injection →
 *  fast, stable real-model turns; avoids polluting busy directories). */
async function pickQuietProject(page: import("@playwright/test").Page): Promise<string> {
  const select = page.getByTitle("Active project")
  await expect(select).toBeVisible({ timeout: 30_000 })
  const values = (await select.locator("option").evaluateAll((els) => els.map((el) => el.value))).filter(Boolean)
  const counts = await page.evaluate(async (dirs) => {
    const out: Record<string, number> = {}
    for (const dir of dirs) {
      try {
        const res = await fetch(`/api/kilo/session?directory=${encodeURIComponent(dir)}`, { credentials: "same-origin" })
        out[dir] = ((await res.json()) as unknown[]).length
      } catch {
        out[dir] = 999
      }
    }
    return out
  }, values.slice(0, 6))
  const best = Object.entries(counts).sort((a, b) => a[1] - b[1])[0]?.[0] ?? values[0]
  await select.selectOption(best)
  return best
}

test.describe("E2E-4R real-model chat", () => {
  test("streams a real reply and keeps the view at the bottom", async ({ page }) => {
    await loginReal(page)
    const dir = await pickQuietProject(page)
    const id = await createSessionViaApi(page, dir)
    expect(id).toBeTruthy()
    try {
      await page.goto(`/session/${id}`)
      // ask agent: cheapest — one short answer, no tools.
      const modeSelect = page.getByTitle("Agent mode")
      await expect
        .poll(async () => await modeSelect.locator("option").count(), { timeout: 30_000 })
        .toBeGreaterThan(1)
      const labels = await modeSelect.locator("option").allTextContents()
      const ask = labels.find((l) => /^ask$/i.test(l.trim())) ?? labels.find((l) => l && l !== "default mode")
      await modeSelect.selectOption({ label: ask! })

      await page.fill("textarea", "Reply with exactly one word: ok")
      await page.getByRole("button", { name: "Send" }).click()

      // The turn goes busy; text grows via message.part.delta events. Real
      // turns with memory injection take 8-30s — poll generously.
      let sawPartial = false
      let lastLen = 0
      for (let i = 0; i < 120; i++) {
        const len = (await page.locator("main").innerText()).length
        if (len > lastLen) {
          const busy = await page.getByRole("button", { name: "Abort" }).isVisible().catch(() => false)
          if (busy) sawPartial = true
          lastLen = len
        }
        const busy = await page.getByRole("button", { name: "Abort" }).isVisible().catch(() => false)
        if (!busy && i > 4) {
          // give a short tail after idle before the API check below
          break
        }
        await page.waitForTimeout(500)
      }

      // Confirm completion through the API (kilo appends synthetic memory
      // messages, so DOM position of the reply is not predictable).
      const replyText = await expect
        .poll(
          async () =>
            await page.evaluate(async (sid) => {
              const res = await fetch(`/api/kilo/session/${sid}/message`, { credentials: "same-origin" })
              const msgs = (await res.json()) as {
                info: { role: string; time: { completed?: number }; error?: unknown }
                parts: { type: string; text?: string }[]
              }[]
              const assistant = msgs.find((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text"))
              if (!assistant) return null
              if (!assistant.info.time.completed) return null
              if (assistant.info.error) return null
              return assistant.parts
                .filter((p) => p.type === "text")
                .map((p) => p.text ?? "")
                .join("\n")
                .trim()
            }, id),
          { timeout: 120_000 },
        )
        .toBeTruthy()
      test.info().annotations.push({ type: "note", description: `sawStreamingPartial=${sawPartial}` })
      console.log("assistant reply:", String(replyText).slice(0, 80))

      // The reply text itself renders as a markdown block (distinct from the
      // user bubble, which contains the longer prompt).
      await expect(page.locator(".md").filter({ hasText: /\bok\b/i }).first()).toBeVisible({ timeout: 30_000 })

      // Autoscroll: near the bottom of the (now huge) scroll container.
      const distance = await page.evaluate(() => {
        const el = document.querySelector("main div.overflow-y-auto") as HTMLElement | null
        return el ? el.scrollHeight - el.scrollTop - el.clientHeight : Number.NaN
      })
      expect(distance).toBeLessThan(300)
    } finally {
      await deleteSessionViaApi(page, id!, dir)
    }
  })
})
