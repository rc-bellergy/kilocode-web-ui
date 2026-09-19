import { expect, test } from "@playwright/test"
import { control, killMock, startMock } from "./mock-kilo-process"
import { createMockSession, login, openSession, resetMock, PROJECT_A } from "./helpers"

test.beforeEach(async ({ page }) => {
  await resetMock()
})

test.describe("E2E-7 realtime updates and reconnect gap-fill", () => {
  test("killed mock → disconnected indicator → restart → gap-fill refetches sessions/statuses AND projects/agents/providers (P0-3)", async ({ page }) => {
    // While healthy: log in and see the project selector with both projects.
    await login(page)
    await expect(page.getByTitle("Active project")).toHaveValue("/tmp/kilo-e2e/project-a")

    // Kill the mock kilo: UI shows the disconnect state and a banner.
    await killMock()
    await expect(page.getByText("events disconnected")).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("div.border-b", { hasText: /unreachable|attach|Cannot attach/i })).toBeVisible({
      timeout: 20_000,
    })

    // Reload while kilo is down: init fails to fetch projects → selector absent.
    await page.reload()
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTitle("Active project")).toHaveCount(0)

    // Restart the mock: SSE reconnects and onOpen gap-fill restores
    // projects (P0-3) plus agents/providers, clearing the banner.
    await startMock()
    await expect(page.getByTitle("Active project")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTitle("Active project")).toHaveValue("/tmp/kilo-e2e/project-a")
    await expect(page.getByText("events disconnected")).toHaveCount(0)
    await expect(page.getByText(/unreachable|Cannot attach/i)).toHaveCount(0, { timeout: 30_000 })

    // Agents/providers came back: opening a session shows the mode options.
    await page.getByRole("button", { name: "+ New session" }).click()
    await expect(page.getByTitle("Agent mode")).toBeVisible()
    const options = await page.getByTitle("Agent mode").locator("option").allTextContents()
    expect(options.join(" ")).toContain("Ask")
    expect(options.join(" ")).toContain("Code")
  })

  test("external session changes appear live", async ({ page }) => {
    await login(page)
    await expect(page.getByText("No sessions yet")).toBeVisible()
    await control("/__control/create-session", { directory: "/tmp/kilo-e2e/project-a" })
    await expect(page.getByText("New session -", { exact: false })).toBeVisible({ timeout: 15_000 })
  })

  test("zombie SSE stream (no events, no error) self-heals via the staleness watchdog", async ({ page }) => {
    await login(page)
    // The stream must be scoped and connected before wedging it.
    await expect(page.getByTitle("Active project")).toHaveValue(PROJECT_A)
    // Shrink the watchdog threshold for the test (re-read on every tick).
    await page.evaluate(() => localStorage.setItem("kilo-web.sseStaleMs", "8000"))
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    await expect(page.getByText("Send a message to start working with Kilo.")).toBeVisible()
    // Fully connected before wedging: server.connected must have arrived on
    // this page, otherwise its late gap-fill would mask the watchdog with a
    // lucky refetch.
    await expect(page.locator('header[data-sse-state="connected"]')).toBeVisible()

    // Wedge the existing stream: the mock stops writing to current SSE
    // clients (no heartbeat, no events) while the connection stays open —
    // the browser never errors, so only the watchdog can recover it.
    await control("/__control/sse-silence", { on: true })
    await control("/__control/append-message", { sessionID, text: "watchdog recovered this message" })

    // Watchdog rebuilds the stream; the fresh server.connected gap-fill
    // refetches the transcript without a page reload.
    await expect(page.getByText("watchdog recovered this message")).toBeVisible({ timeout: 30_000 })
    await control("/__control/sse-silence", { on: false })
  })

  test("busy session catches up via the message poll when events are lost but the stream heartbeats", async ({ page }) => {
    await login(page)
    await expect(page.getByTitle("Active project")).toHaveValue(PROJECT_A)
    const sessionID = await createMockSession()
    await openSession(page, sessionID)
    // Fully connected first: otherwise a late connect's gap-fill refetch
    // would mask the poll with a lucky transcript reload.
    await expect(page.locator('header[data-sse-state="connected"]')).toBeVisible()

    // Busy with no further events (hang), then grow the transcript silently.
    // Heartbeats keep the SSE stream "alive", so only the busy-poll can
    // surface the new message.
    await control("/__control/hang", { sessionID })
    await expect(page.getByText("working", { exact: true })).toBeVisible()
    await control("/__control/append-message", { sessionID, text: "poll recovered this message" })

    await expect(page.getByText("poll recovered this message")).toBeVisible({ timeout: 30_000 })
    // The stream itself never went down.
    await expect(page.getByText("events disconnected")).toHaveCount(0)
  })

  test("boot while kilo is down: the late-learned directory re-points the event stream", async ({ page }) => {
    await killMock()
    await login(page)
    // Booted against a down kilo: banner up, no projects yet; the proxy holds
    // the event stream open WITHOUT a directory.
    await expect(page.locator("div.border-b", { hasText: /unreachable|attach|Cannot attach/i })).toBeVisible({
      timeout: 20_000,
    })

    await startMock()
    // A session created immediately (before the app's gap-fill) makes the
    // rescue path "sessions list still empty" inapplicable — only the
    // refreshProjects directory fallback can fix the stream scope.
    const orphan = "/tmp/kilo-e2e/orphan-dir"
    await control("/__control/create-session", { directory: orphan })

    // Recovery gap-fill loads projects; the fallback directory is applied and
    // the event stream re-connected WITH that directory.
    await expect(page.getByTitle("Active project")).toHaveValue(orphan, { timeout: 30_000 })
    await expect(page.getByText("New session -", { exact: false })).toHaveCount(1, { timeout: 15_000 })

    // Project-scoped live events must now arrive without a reload.
    await control("/__control/create-session", { directory: orphan })
    await expect(page.getByText("New session -", { exact: false })).toHaveCount(2, { timeout: 15_000 })
  })
})
