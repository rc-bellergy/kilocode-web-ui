import crypto from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import { kilo } from "./kilo.js"

const COOKIE_NAME = "kw_session"
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const webPassword = process.env.KILO_WEB_PASSWORD
if (!webPassword) {
  console.warn("[auth] KILO_WEB_PASSWORD is not set; using default password \"kilo\". Set it in production!")
}

// Random per-start signing key: restarting the backend invalidates sessions (by design).
const hmacKey = crypto.randomBytes(32)

function sign(payload: string): string {
  return crypto.createHmac("sha256", hmacKey).update(payload).digest("base64url")
}

export function makeToken(expiredMsAgo = 0): string {
  const exp = Date.now() + SESSION_TTL_MS - expiredMsAgo
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  return `${payload}.${sign(payload)}`
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return false
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof data.exp === "number" && data.exp > Date.now()
  } catch {
    return false
  }
}

export function passwordMatches(input: unknown): boolean {
  if (typeof input !== "string") return false
  const expected = webPassword || "kilo"
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // still compare to keep timing roughly constant
    crypto.timingSafeEqual(b, b)
    return false
  }
  return crypto.timingSafeEqual(a, b)
}

const cookieOpts = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.COOKIE_SECURE === "1",
  path: "/",
  maxAge: SESSION_TTL_MS,
}

// In-memory login rate limit (P1-1): per IP + global buckets of failures.
// A single backend instance per process by design; resets on restart.
const RATE_WINDOW_MS = 60_000
const RATE_MAX_FAILURES = 10

interface Bucket {
  failures: number
  windowStart: number
}

const ipBuckets = new Map<string, Bucket>()
const globalBucket: Bucket = { failures: 0, windowStart: 0 }

function bucketHit(bucket: Bucket): boolean {
  const now = Date.now()
  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.failures = 0
    bucket.windowStart = now
  }
  return bucket.failures >= RATE_MAX_FAILURES
}

function bucketFail(bucket: Bucket): void {
  bucket.failures++
  if (!bucket.windowStart) bucket.windowStart = Date.now()
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown"
}

/** Test hook: clear the in-memory login rate-limit buckets. */
export function resetLoginRateLimit(): void {
  ipBuckets.clear()
  globalBucket.failures = 0
  globalBucket.windowStart = 0
}

export function authRoutes(app: import("express-serve-static-core").Router) {
  app.post("/login", (req: Request, res: Response) => {
    const ip = clientKey(req)
    const ipBucket = ipBuckets.get(ip) ?? { failures: 0, windowStart: 0 }
    if (bucketHit(ipBucket) || bucketHit(globalBucket)) {
      ipBuckets.set(ip, ipBucket)
      res.status(429).json({ error: "Too many attempts; try again in a minute" })
      return
    }
    if (!passwordMatches((req.body as { password?: unknown } | undefined)?.password)) {
      bucketFail(ipBucket)
      ipBuckets.set(ip, ipBucket)
      bucketFail(globalBucket)
      res.status(401).json({ error: "Invalid password" })
      return
    }
    ipBuckets.delete(ip)
    res.cookie(COOKIE_NAME, makeToken(), cookieOpts)
    res.json({ ok: true })
  })

  app.post("/logout", (_req: Request, res: Response) => {
    res.clearCookie(COOKIE_NAME, { path: "/" })
    res.json({ ok: true })
  })

  app.get("/session", (req: Request, res: Response) => {
    res.json({ authenticated: verifyToken(req.cookies?.[COOKIE_NAME]) })
  })
}

/** Require a valid session for everything under /api (auth and health are handled before this). */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/auth/login" || req.path === "/health") return next()
  if (verifyToken(req.cookies?.[COOKIE_NAME])) return next()
  res.status(401).json({ error: "Not authenticated" })
}

export function healthHandler(req: Request, res: Response) {
  // Anonymous callers only learn whether kilo is ready (P1-2); internal URL
  // and error details stay behind a session. Also re-kick a stalled attach.
  if (!verifyToken(req.cookies?.[COOKIE_NAME])) {
    res.json({ kilo: { ready: kilo.status.ready } })
    return
  }
  kilo.retryNow()
  res.json({ kilo: kilo.status })
}
