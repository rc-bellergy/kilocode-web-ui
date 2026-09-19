import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { Request, Response } from "express"
import { createApp } from "../src/app.js"
import { checkAddress, ipAllowlist, parseAllowlist } from "../src/ipAllowlist.js"

const originalAllowlist = process.env.ALLOWED_IPS

afterAll(() => {
  if (originalAllowlist === undefined) delete process.env.ALLOWED_IPS
  else process.env.ALLOWED_IPS = originalAllowlist
})

let server: http.Server
let base: string

function startApp(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(createApp())
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

beforeEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  base = await startApp()
})

afterEach(async () => {
  delete process.env.ALLOWED_IPS
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe("parseAllowlist", () => {
  it("returns null when unset, empty, or only separators", () => {
    expect(parseAllowlist(undefined)).toBeNull()
    expect(parseAllowlist("")).toBeNull()
    expect(parseAllowlist("   ")).toBeNull()
    expect(parseAllowlist(" , , ")).toBeNull()
  })

  it("matches single IPv4, IPv6, and CIDR entries", () => {
    const v4 = parseAllowlist("127.0.0.1")!
    expect(checkAddress(v4, "127.0.0.1")).toBe(true)
    expect(checkAddress(v4, "127.0.0.2")).toBe(false)
    const v6 = parseAllowlist("::1")!
    expect(checkAddress(v6, "::1")).toBe(true)
    expect(checkAddress(v6, "::2")).toBe(false)
    const cidr = parseAllowlist("203.0.113.0/24")!
    expect(checkAddress(cidr, "203.0.113.0")).toBe(true)
    expect(checkAddress(cidr, "203.0.113.255")).toBe(true)
    expect(checkAddress(cidr, "203.0.114.1")).toBe(false)
    expect(checkAddress(cidr, "127.0.0.1")).toBe(false)
  })

  it("accepts comma-separated mixed lists with whitespace", () => {
    const list = parseAllowlist(" 127.0.0.1 , ::1 , 203.0.113.0/24 ")!
    expect(checkAddress(list, "127.0.0.1")).toBe(true)
    expect(checkAddress(list, "::1")).toBe(true)
    expect(checkAddress(list, "203.0.113.5")).toBe(true)
    expect(checkAddress(list, "203.0.112.5")).toBe(false)
    expect(checkAddress(list, "8.8.8.8")).toBe(false)
  })

  it("throws on invalid entries (fail loudly at startup)", () => {
    expect(() => parseAllowlist("not-an-ip")).toThrow(/ALLOWED_IPS/)
    expect(() => parseAllowlist("999.999.1.1")).toThrow(/ALLOWED_IPS/)
    expect(() => parseAllowlist("203.0.113.0/33")).toThrow(/ALLOWED_IPS/)
    expect(() => parseAllowlist("203.0.113.0/abc")).toThrow(/ALLOWED_IPS/)
    expect(() => parseAllowlist("203.0.113.0/-1")).toThrow(/ALLOWED_IPS/)
    expect(() => parseAllowlist("127.0.0.1,bogus")).toThrow(/ALLOWED_IPS/)
  })
})

describe("ipAllowlist middleware", () => {
  function call(remoteAddress: string | undefined, allowed: string): Promise<{ status?: number; body?: unknown; nexted: boolean }> {
    return new Promise((resolve) => {
      const handler = ipAllowlist(parseAllowlist(allowed)!)
      const req = {
        method: "GET",
        url: "/",
        socket: remoteAddress === undefined ? {} : { remoteAddress },
      } as unknown as Request
      let status: number | undefined
      const res = {
        status(code: number) {
          status = code
          return res
        },
        json(body: unknown) {
          resolve({ status, body, nexted: false })
          return res
        },
      } as unknown as Response
      handler(req, res, () => resolve({ nexted: true }))
    })
  }

  it("lets allowed plain and IPv6-mapped addresses through", async () => {
    expect((await call("203.0.113.5", "203.0.113.0/24")).nexted).toBe(true)
    expect((await call("::ffff:203.0.113.5", "203.0.113.0/24")).nexted).toBe(true)
    expect((await call("::1", "127.0.0.1,::1")).nexted).toBe(true)
  })

  it("rejects out-of-list addresses and missing remote address with 403", async () => {
    const denied = await call("192.168.1.10", "203.0.113.0/24")
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: "Forbidden" })
    const noAddr = await call(undefined, "203.0.113.0/24")
    expect(noAddr.status).toBe(403)
  })

  it("logs the rejected source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await call("192.168.1.10", "203.0.113.0/24")
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("192.168.1.10"))
    } finally {
      warn.mockRestore()
    }
  })
})

describe("app integration (ALLOWED_IPS flipped per app instance)", () => {
  it("does not restrict when ALLOWED_IPS is unset or empty", async () => {
    delete process.env.ALLOWED_IPS
    if (server) await new Promise<void>((r) => server.close(() => r()))
    base = await startApp()
    expect((await fetch(`${base}/api/health`)).status).toBe(200)

    process.env.ALLOWED_IPS = ""
    if (server) await new Promise<void>((r) => server.close(() => r()))
    base = await startApp()
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })

  it("allows loopback for the documented homelab list", async () => {
    process.env.ALLOWED_IPS = "127.0.0.1,::1,203.0.113.0/24"
    if (server) await new Promise<void>((r) => server.close(() => r()))
    base = await startApp()
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })

  it("403s every route (health, auth, SPA) when the source is not allowlisted", async () => {
    process.env.ALLOWED_IPS = "10.99.0.1"
    if (server) await new Promise<void>((r) => server.close(() => r()))
    base = await startApp()
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(403)
    expect(await health.json()).toEqual({ error: "Forbidden" })
    expect((await fetch(`${base}/api/auth/session`)).status).toBe(403)
    expect((await fetch(`${base}/`)).status).toBe(403)
    expect((await fetch(`${base}/api/auth/login`, { method: "POST" })).status).toBe(403)
  })
})
