import { afterAll, afterEach, describe, expect, it } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KiloManager } from "../src/kilo.js"
import { startMockKilo, type MockKilo } from "./mock-kilo-server.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = path.join(__dirname, "fake-cli.mjs")

const FAST = { restartBaseDelayMs: 20, startupTimeoutMs: 800 }

function newManager(env: Record<string, string | undefined>, opts = {}): KiloManager {
  const saved: Record<string, string | undefined> = {}
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  const manager = new KiloManager(opts)
  ;(manager as unknown as { __restore: () => void }).__restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return manager
}

function restore(manager: KiloManager): void {
  ;(manager as unknown as { __restore: () => void }).__restore()
}

function waitFor<T>(probe: () => T, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const value = probe()
      if (value) return resolve(value)
      if (Date.now() - t0 > timeoutMs) return reject(new Error("waitFor timeout"))
      setTimeout(tick, 20)
    }
    tick()
  })
}

const managers: KiloManager[] = []
function track(m: KiloManager): KiloManager {
  managers.push(m)
  return m
}

afterEach(() => {
  for (const m of managers.splice(0)) {
    m.stop()
    restore(m)
  }
})

afterAll(() => {
  for (const m of managers.splice(0)) m.stop()
})

describe("spawn mode", () => {
  it("becomes ready from the CLI ready line", async () => {
    const m = track(
      newManager({ KILO_CLI_PATH: FAKE_CLI, FAKE_MODE: "ready", FAKE_URL: "http://127.0.0.1:12345", KILO_SERVER_URL: undefined }, FAST),
    )
    await m.init()
    await waitFor(() => m.status.ready)
    expect(m.status.mode).toBe("spawned")
    expect(m.status.url).toBe("http://127.0.0.1:12345")
    expect(m.status.error).toBeNull()
  })

  it("gives up after 5 failed startups (never ready)", async () => {
    const m = track(
      newManager(
        { KILO_CLI_PATH: FAKE_CLI, FAKE_MODE: "never-ready", KILO_SERVER_URL: undefined },
        { ...FAST, healthyResetMs: 60_000 },
      ),
    )
    await m.init()
    await waitFor(() => m.status.error?.includes("failed to start after 5"), 10_000)
    expect(m.status.ready).toBe(false)
    expect(m.startAttempts).toBeGreaterThanOrEqual(5)
  }, 15_000)

  it("gives up after 5 quick crash-restarts: budget only resets when healthy >= 5 min (P0-2)", async () => {
    const m = track(
      newManager(
        { KILO_CLI_PATH: FAKE_CLI, FAKE_MODE: "ready-then-exit", FAKE_EXIT_MS: "40", KILO_SERVER_URL: undefined },
        { ...FAST, healthyResetMs: 60_000 },
      ),
    )
    await m.init()
    // Each attempt: ready → crash 40ms later → restart, budget never resets.
    await waitFor(() => m.status.error?.includes("failed to start after 5"), 20_000)
    expect(m.status.ready).toBe(false)
  }, 25_000)

  it("resets the restart budget after a healthy episode (P0-2)", async () => {
    const m = track(
      newManager(
        { KILO_CLI_PATH: FAKE_CLI, FAKE_MODE: "ready-then-exit", FAKE_EXIT_MS: "1200", KILO_SERVER_URL: undefined },
        { ...FAST, healthyResetMs: 400 },
      ),
    )
    await m.init()
    // First episode: ready, stays healthy 400ms (budget reset), crashes at 1.2s.
    await waitFor(() => m.status.ready)
    await waitFor(() => m.startAttempts === 0, 2_000) // healthy >= 400ms → reset
    await waitFor(() => !m.status.ready, 4_000) // crash at ~1.2s
    // A second spawn must be attempt #1 again (budget was reset).
    await waitFor(() => m.status.ready, 5_000)
    expect(m.startAttempts).toBe(1)
  })

  it("stop() kills the spawned child", async () => {
    const m = track(
      newManager({ KILO_CLI_PATH: FAKE_CLI, FAKE_MODE: "ready", KILO_SERVER_URL: undefined }, FAST),
    )
    await m.init()
    await waitFor(() => m.status.ready)
    m.stop()
    await waitFor(() => !m.status.ready, 2_000)
  })
})

describe("attach mode", () => {
  it("attaches to a running kilo server", async () => {
    const mock = await startMockKilo()
    try {
      const m = track(newManager({ KILO_SERVER_URL: mock.kiloUrl }, { attachProbeMs: 100 }))
      await m.init()
      await waitFor(() => m.status.ready)
      expect(m.status.mode).toBe("attached")
      expect(m.status.url).toBe(mock.kiloUrl)
      expect(m.status.error).toBeNull()
      m.stop()
    } finally {
      await mock.close()
    }
  })

  it("retries attach at boot until the target appears (P0-1)", async () => {
    // Target does not exist yet; manager must keep retrying, then succeed.
    const holder = await startMockKilo({ kiloPort: 0 })
    const port = holder.kiloPort
    await holder.close()
    const m = track(
      newManager({ KILO_SERVER_URL: `http://127.0.0.1:${port}` }, { attachProbeMs: 100, attachTimeoutMs: 300, restartBaseDelayMs: 50 }),
    )
    await m.init()
    await waitFor(() => m.status.error?.includes("Cannot attach"), 3_000)
    expect(m.status.ready).toBe(false)
    const mock = await startMockKilo({ kiloPort: port })
    try {
      await waitFor(() => m.status.ready, 5_000)
      expect(m.status.error).toBeNull()
      m.stop()
    } finally {
      await mock.close()
    }
  })

  it("detects a dead target and re-attaches when it comes back (P0-1)", async () => {
    const mock = await startMockKilo()
    const port = mock.kiloPort
    const m = track(
      newManager({ KILO_SERVER_URL: mock.kiloUrl }, { attachProbeMs: 120, attachTimeoutMs: 400, restartBaseDelayMs: 50 }),
    )
    await m.init()
    await waitFor(() => m.status.ready)
    await mock.close()
    await waitFor(() => !m.status.ready && m.status.error !== null, 4_000)
    expect(m.status.error).toMatch(/unreachable|attach|Re-attaching/)
    const revived = await startMockKilo({ kiloPort: port })
    try {
      await waitFor(() => m.status.ready, 6_000)
      expect(m.status.error).toBeNull()
      m.stop()
    } finally {
      await revived.close()
    }
  })

  it("stops retrying on 401 (bad credentials are terminal)", async () => {
    const mock = await startMockKilo({ password: "mock-secret" })
    try {
      const m = track(
        newManager({ KILO_SERVER_URL: mock.kiloUrl, KILO_SERVER_PASSWORD: undefined }, { attachProbeMs: 100 }),
      )
      await m.init()
      await waitFor(() => m.status.error?.includes("rejected credentials"), 3_000)
      expect(m.status.ready).toBe(false)
      // No further retry churn: error stays the same.
      const firstError = m.status.error
      await new Promise((r) => setTimeout(r, 300))
      expect(m.status.error).toBe(firstError)
      m.stop()
    } finally {
      await mock.close()
    }
  })

  it("attaches with matching credentials", async () => {
    const mock = await startMockKilo({ password: "mock-secret" })
    try {
      const m = track(
        newManager({ KILO_SERVER_URL: mock.kiloUrl, KILO_SERVER_PASSWORD: "mock-secret" }, { attachProbeMs: 100 }),
      )
      await m.init()
      await waitFor(() => m.status.ready)
      expect(m.authHeader()).toContain("Basic ")
      m.stop()
    } finally {
      await mock.close()
    }
  })
})
