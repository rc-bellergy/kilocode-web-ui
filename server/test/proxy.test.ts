import { afterAll, beforeAll, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { startMockKilo, type MockKilo } from "./mock-kilo-server.js"

// The proxy reads the `kilo` singleton, whose mode is decided at module load
// from KILO_SERVER_URL — so the mock must be up before importing app code.
const mock: MockKilo = await startMockKilo()
process.env.KILO_SERVER_URL = mock.kiloUrl
process.env.KILO_WEB_PASSWORD = "proxy-test"
const { createApp } = await import("../src/app.js")
const { kilo } = await import("../src/kilo.js")

let server: http.Server
let base: string
let cookie: string

beforeAll(async () => {
  server = http.createServer(createApp())
  base = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "proxy-test" }),
  })
  cookie = login.headers.get("set-cookie")!.split(";")[0]
})

afterAll(async () => {
  kilo.stop()
  await new Promise<void>((r) => server.close(() => r()))
  await mock.close()
})

describe("proxy", () => {
  it("returns 503 when kilo is not ready", async () => {
    const res = await fetch(`${base}/api/kilo/project`, { headers: { cookie } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain("not ready")
  })

  it("proxies REST after kilo becomes ready, filtering hop-by-hop/set-cookie headers", async () => {
    await kilo.init()
    await waitForReady()
    const res = await fetch(`${base}/api/kilo/project`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const projects = (await res.json()) as { worktree: string }[]
    expect(projects.length).toBeGreaterThan(0)
    expect(res.headers.get("x-mock-header")).toBe("yes")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("forwards the request body (create session) and query params", async () => {
    const dir = encodeURIComponent("/tmp/kilo-e2e/project-a")
    const res = await fetch(`${base}/api/kilo/session?directory=${dir}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(200)
    const session = (await res.json()) as { id: string; directory: string }
    expect(session.id).toMatch(/^ses_/)
    expect(session.directory).toBe("/tmp/kilo-e2e/project-a")
  })

  it("requires auth on the proxy path", async () => {
    const res = await fetch(`${base}/api/kilo/project`)
    expect(res.status).toBe(401)
  })

  it("pipes SSE events through and propagates client abort", async () => {
    const ac = new AbortController()
    const res = await fetch(`${base}/api/kilo/event`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const reader = res.body!.getReader()
    const connected = await readUntil(reader, "server.connected")
    expect(connected).toBe(true)

    // Upstream should now have exactly this one SSE client.
    expect(mock.state.sseClients).toBe(1)

    // Emit an event from the mock; it must arrive through the proxy.
    mock.emit("session.status", { sessionID: "ses_proxytest", status: { type: "busy" } }, null)
    let buf = ""
    let sawBusy = false
    for (let i = 0; i < 20 && !sawBusy; i++) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ])
      if (!chunk?.value) break
      buf += new TextDecoder().decode(chunk.value)
      if (buf.includes("ses_proxytest")) sawBusy = true
    }
    expect(sawBusy).toBe(true)

    // Abort the client; the upstream client count must drop.
    ac.abort()
    await waitFor(() => mock.state.sseClients === 0)
  }, 20_000)

  it("forwards Last-Event-ID on the SSE upstream request (P1-3)", async () => {
    const ac = new AbortController()
    const res = await fetch(`${base}/api/kilo/event`, {
      headers: { cookie, accept: "text/event-stream", "Last-Event-ID": "evt_forwarded_123" },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    await readUntil(res.body!.getReader(), "server.connected")
    ac.abort()
    expect(mock.state.lastEventIDs.at(-1)).toBe("evt_forwarded_123")
  })
})

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, tries = 30): Promise<boolean> {
  const decoder = new TextDecoder()
  let buf = ""
  for (let i = 0; i < tries; i++) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
    ])
    if (!chunk?.value) break
    buf += decoder.decode(chunk.value)
    if (buf.includes(needle)) return true
  }
  return false
}

function waitFor(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (probe()) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error("waitFor timeout"))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function waitForReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (kilo.status.ready) return resolve()
      if (Date.now() - t0 > 5_000) return reject(new Error("kilo never became ready"))
      setTimeout(tick, 20)
    }
    tick()
  })
}
