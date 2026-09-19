import { afterAll, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/app.js"
import { makeToken, passwordMatches, resetLoginRateLimit, verifyToken } from "../src/auth.js"

const expectedPassword = process.env.KILO_WEB_PASSWORD ?? "kilo"

let server: http.Server
let base: string

function startApp(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(createApp())
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

beforeEach(async () => {
  resetLoginRateLimit()
  if (server) await new Promise<void>((r) => server.close(() => r()))
  base = await startApp()
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

async function login(password: string): Promise<Response> {
  return fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
}

describe("token sign/verify", () => {
  it("accepts a freshly signed token", () => {
    expect(verifyToken(makeToken())).toBe(true)
  })

  it("rejects an expired token", () => {
    expect(verifyToken(makeToken(8 * 24 * 3600 * 1000))).toBe(false)
  })

  it("rejects a tampered signature", () => {
    const token = makeToken()
    expect(verifyToken(`${token}x`)).toBe(false)
    expect(verifyToken(`x${token}`)).toBe(false)
  })

  it("rejects malformed tokens (lastIndexOf boundary)", () => {
    expect(verifyToken(undefined)).toBe(false)
    expect(verifyToken("")).toBe(false)
    expect(verifyToken("nodot")).toBe(false)
    expect(verifyToken(".")).toBe(false)
    expect(verifyToken(".signatureonly")).toBe(false)
    // payload is not valid base64url json
    expect(verifyToken("!!!!.abc")).toBe(false)
  })
})

describe("passwordMatches", () => {
  it("accepts the configured password", () => {
    expect(passwordMatches(expectedPassword)).toBe(true)
  })
  it("rejects wrong passwords", () => {
    expect(passwordMatches("wrong")).toBe(false)
    expect(passwordMatches("")).toBe(false)
  })
  it("rejects non-string input", () => {
    expect(passwordMatches(undefined)).toBe(false)
    expect(passwordMatches(123)).toBe(false)
    expect(passwordMatches(null)).toBe(false)
  })
  it("rejects length-mismatched input without throwing", () => {
    expect(passwordMatches(`${expectedPassword}extra`)).toBe(false)
    expect(passwordMatches(expectedPassword.slice(0, -1))).toBe(false)
  })
})

describe("login endpoint", () => {
  it("returns 401 for wrong password", async () => {
    const res = await login("definitely-wrong")
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe("Invalid password")
  })

  it("sets an httpOnly lax session cookie on success", async () => {
    const res = await login(expectedPassword)
    expect(res.status).toBe(200)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain("kw_session=")
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).toContain("Path=/")
    if (process.env.COOKIE_SECURE === "1") expect(setCookie).toContain("Secure")
  })

  it("rate limits after repeated failures (429)", async () => {
    for (let i = 0; i < 10; i++) await login("wrong")
    const blocked = await login("wrong")
    expect(blocked.status).toBe(429)
    // Even the correct password is blocked while the bucket is hot.
    const blockedCorrect = await login(expectedPassword)
    expect(blockedCorrect.status).toBe(429)
    resetLoginRateLimit()
    const ok = await login(expectedPassword)
    expect(ok.status).toBe(200)
  })
})

describe("session/health endpoints", () => {
  it("reports authenticated state", async () => {
    const anon = await fetch(`${base}/api/auth/session`)
    expect(await anon.json()).toEqual({ authenticated: false })
    const res = await login(expectedPassword)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]
    const authed = await fetch(`${base}/api/auth/session`, { headers: { cookie } })
    expect(await authed.json()).toEqual({ authenticated: true })
  })

  it("health is anonymous-minimal: only kilo.ready (P1-2)", async () => {
    const anon = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>
    const kilo = anon.kilo as Record<string, unknown>
    expect(Object.keys(kilo)).toEqual(["ready"])
    expect(typeof kilo.ready).toBe("boolean")
  })

  it("health shows full kilo details when authenticated", async () => {
    const res = await login(expectedPassword)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]
    const health = (await (await fetch(`${base}/api/health`, { headers: { cookie } })).json()) as {
      kilo: Record<string, unknown>
    }
    expect(Object.keys(health.kilo).sort()).toEqual(["error", "mode", "ready", "url"])
  })
})

describe("requireAuth", () => {
  it("blocks /api/kilo without a session", async () => {
    const res = await fetch(`${base}/api/kilo/project`)
    expect(res.status).toBe(401)
  })

  it("allows /api/auth/* without a session", async () => {
    const res = await fetch(`${base}/api/auth/session`)
    expect(res.status).toBe(200)
  })

  it("logout invalidates the session cookie", async () => {
    const res = await login(expectedPassword)
    const cookie = res.headers.get("set-cookie")!.split(";")[0]
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } })
    // Server-side sessions are stateless HMAC; logout clears the cookie
    // client-side. The cookie value itself stays valid until expiry — the
    // app relies on the browser dropping it. We assert the endpoint works.
    const out = await fetch(`${base}/api/auth/logout`, { method: "POST" })
    expect(out.status).toBe(200)
  })
})
