import { afterAll, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { createApp } from "../src/app.js"
import { resetLoginRateLimit } from "../src/auth.js"

let server: http.Server
let base: string
let dataDir: string

function startApp(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(createApp())
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

const expectedPassword = process.env.KILO_WEB_PASSWORD ?? "kilo"

async function loginCookie(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: expectedPassword }),
  })
  return res.headers.get("set-cookie")!.split(";")[0]
}

async function getFavourites(cookie = ""): Promise<Response> {
  return fetch(`${base}/api/favourites`, { headers: cookie ? { cookie } : {} })
}

async function putFavourites(body: unknown, cookie = ""): Promise<Response> {
  return fetch(`${base}/api/favourites`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { providerID: "p1", modelID: "m1", name: "Model One", addedAt: 1_789_900_000_000, ...overrides }
}

beforeEach(async () => {
  resetLoginRateLimit()
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-fav-"))
  process.env.KILO_WEB_DATA_DIR = dataDir
  if (server) await new Promise<void>((r) => server.close(() => r()))
  base = await startApp()
})

afterAll(async () => {
  delete process.env.KILO_WEB_DATA_DIR
  await new Promise<void>((r) => server.close(() => r()))
})

describe("favourites auth", () => {
  it("blocks GET/PUT without a session", async () => {
    expect((await getFavourites()).status).toBe(401)
    expect((await putFavourites({ favourites: [] })).status).toBe(401)
  })
})

describe("GET /api/favourites", () => {
  it("returns an empty list when the file does not exist", async () => {
    const cookie = await loginCookie()
    const res = await getFavourites(cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ favourites: [] })
  })

  it("returns an empty list on corrupted JSON instead of crashing", async () => {
    fs.writeFileSync(path.join(dataDir, "favourites.json"), "{not json")
    const cookie = await loginCookie()
    const res = await getFavourites(cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ favourites: [] })
  })

  it("drops invalid entries but keeps valid ones", async () => {
    fs.writeFileSync(
      path.join(dataDir, "favourites.json"),
      JSON.stringify({ favourites: [item(), { providerID: "p2" }, "junk"] }),
    )
    const cookie = await loginCookie()
    const body = (await (await getFavourites(cookie)).json()) as { favourites: unknown[] }
    expect(body.favourites).toHaveLength(1)
  })
})

describe("PUT /api/favourites", () => {
  it("round-trips a valid list and writes the file atomically", async () => {
    const cookie = await loginCookie()
    const favourites = [item(), item({ providerID: "p2", modelID: "m2", name: undefined })]
    const res = await putFavourites({ favourites }, cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ favourites })

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "favourites.json"), "utf8"))
    expect(stored).toEqual({ favourites })
    expect(fs.readdirSync(dataDir).some((f) => f.startsWith("favourites.json.tmp-"))).toBe(false)

    expect(await (await getFavourites(cookie)).json()).toEqual({ favourites })
  })

  it("dedupes entries with the same providerID/modelID", async () => {
    const cookie = await loginCookie()
    const res = await putFavourites({ favourites: [item(), item({ name: "dup", addedAt: 2 })] }, cookie)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { favourites: { addedAt: number }[] }
    expect(body.favourites).toHaveLength(1)
  })

  it("rejects invalid payloads with 400", async () => {
    const cookie = await loginCookie()
    const bad = [
      { favourites: "nope" },
      { favourites: [item({ providerID: "" })] },
      { favourites: [item({ modelID: "" })] },
      { favourites: [item({ providerID: 5, modelID: "m" })] },
      { favourites: [item({ addedAt: "now" })] },
      { favourites: [item({ name: "x".repeat(201) })] },
      { favourites: [item({ name: 7 })] },
      {},
    ]
    for (const payload of bad) {
      const res = await putFavourites(payload, cookie)
      expect(res.status, JSON.stringify(payload)).toBe(400)
    }
  })

  it("rejects more than 200 items", async () => {
    const cookie = await loginCookie()
    const many = Array.from({ length: 201 }, (_, i) => item({ providerID: `p${i}`, modelID: `m${i}` }))
    expect((await putFavourites({ favourites: many }, cookie)).status).toBe(400)
    const exactly200 = many.slice(0, 200)
    expect((await putFavourites({ favourites: exactly200 }, cookie)).status).toBe(200)
  })

  it("keeps the previous file untouched after a rejected PUT", async () => {
    const cookie = await loginCookie()
    await putFavourites({ favourites: [item()] }, cookie)
    await putFavourites({ favourites: [{ providerID: "", modelID: "x", addedAt: 1 }] }, cookie)
    expect(await (await getFavourites(cookie)).json()).toEqual({ favourites: [item()] })
  })
})
