import { Readable } from "node:stream"
import type { Request, Response } from "express"
import { kilo } from "./kilo.js"

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
])

export function proxyHandler(req: Request, res: Response) {
  // SSE first: when kilo is not ready the EventSource must be held open (a
  // non-200 response makes browsers close the stream permanently instead of
  // reconnecting). pipeSse waits for kilo to recover.
  if (req.url === "/event" || req.url.startsWith("/event?")) {
    void pipeSse(req, res)
    return
  }

  const base = kilo.baseUrl()
  if (!base || !kilo.status.ready) {
    res.status(503).json({ error: "kilo server is not ready" })
    return
  }

  // ?directory= and all other query params pass straight through in req.url.
  const target = `${base}${req.url}`
  void proxyRequest(target, req, res)
}

async function proxyRequest(target: string, req: Request, res: Response) {
  const dbg = process.env.KILO_SSE_DEBUG === "1" ? (m: string) => console.log(`[px ${Date.now()}] ${m}`) : () => {}
  dbg(`${req.method} ${req.url}${req.body && (req.body as Buffer).length ? ` body=${String((req.body as Buffer).toString("utf8")).slice(0, 300)}` : ""}`)
  try {
    const headers: Record<string, string> = { accept: req.headers.accept ?? "*/*" }
    if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"])
    const auth = kilo.authHeader()
    if (auth) headers.authorization = auth

    let body: Buffer | undefined
    if (!["GET", "HEAD"].includes(req.method)) {
      body = Buffer.isBuffer(req.body)
        ? (req.body as Buffer)
        : req.body !== undefined && Object.keys(req.body).length > 0
          ? Buffer.from(JSON.stringify(req.body))
          : undefined
    }
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    })

    res.status(upstream.status)
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase()
      if (HOP_HEADERS.has(lower) || lower === "content-encoding" || lower === "content-length") return
      if (lower === "set-cookie") return
      res.setHeader(name, value)
    })
    if (!upstream.body) {
      res.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)
    stream.pipe(res)
    stream.on("error", () => res.end())
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: `kilo server request failed: ${message(err)}` })
    } else {
      res.end()
    }
  }
}

async function pipeSse(req: Request, res: Response) {
  const dbg = process.env.KILO_SSE_DEBUG === "1" ? (m: string) => console.log(`[sse ${Date.now()}] ${m}`) : () => {}
  dbg(`request ${req.url}`)
  const abort = new AbortController()
  req.on("close", () => {
    dbg("req closed")
    abort.abort()
  })
  res.on("close", () => {
    dbg("res closed")
    abort.abort()
  })
  const stopped = () => abort.signal.aborted || res.writableEnded || res.destroyed

  // Open the client stream immediately: a non-200 (or non-event-stream)
  // response makes browsers close the EventSource permanently instead of
  // reconnecting. All failures — kilo down, probe lag, refused upstream —
  // are handled INSIDE this stream with keepalives and retries.
  sseHeaders(res)
  res.flushHeaders()
  res.write("retry: 2000\n\n")

  // Base headers only: the Basic auth header must be built per attempt —
  // spawn-mode kilo restarts rotate the password (P0-1 restart path).
  const headers: Record<string, string> = { accept: "text/event-stream" }
  const lastEventID = req.headers["last-event-id"]
  if (typeof lastEventID === "string" && lastEventID) headers["last-event-id"] = lastEventID

  const deadline = Date.now() + 120_000
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(":ka\n\n")
  }, 10_000)

  const cleanup = () => {
    clearInterval(keepAlive)
    abort.abort()
    if (!res.writableEnded) res.end()
  }

  try {
    while (Date.now() < deadline && !stopped()) {
      // Wait for kilo readiness (the ready flag may lag a kill by one probe).
      if (!kilo.baseUrl() || !kilo.status.ready) {
        dbg("waiting for kilo ready")
        await waitFor(() => (kilo.baseUrl() && kilo.status.ready) || stopped(), deadline - Date.now())
        if (stopped()) return
        if (!kilo.baseUrl() || !kilo.status.ready) break // deadline hit
        dbg("kilo became ready")
      }

      try {
        // Connect timeout only (P1-3): the timer must not abort the body
        // stream once connected, or healthy long-lived SSE dies after 10s.
        const connectAbort = new AbortController()
        const connectTimer = setTimeout(() => connectAbort.abort(), 10_000)
        const signal =
          typeof AbortSignal.any === "function"
            ? AbortSignal.any([abort.signal, connectAbort.signal])
            : abort.signal
        const auth = kilo.authHeader()
        const upstream = await fetch(`${kilo.baseUrl()}${req.url}`, {
          headers: auth ? { ...headers, authorization: auth } : headers,
          signal,
        })
        clearTimeout(connectTimer)
        if (upstream.ok && upstream.body) {
          dbg(`upstream connected ${kilo.baseUrl()}`)
          const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream)
          stream.pipe(res)
          stream.on("error", (err) => {
            dbg(`stream error: ${err.message}`)
            cleanup()
          })
          stream.on("close", () => {
            dbg("stream closed")
            cleanup()
          })
          res.on("close", cleanup)
          return
        }
        // Non-ok upstream (e.g. rotated password pre-restart): fall through
        // and retry with fresh credentials below.
        dbg(`upstream non-ok status ${upstream.status}`)
      } catch (err) {
        // Upstream refused (ready flag stale, kilo dying/restarting): retry.
        dbg(`upstream attempt failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // Give the manager a moment to flip not-ready (probe) so the loop
      // cannot spin against a stale ready flag; bounded so a persistently
      // unhealthy upstream is still retried periodically.
      await waitFor(() => !kilo.status.ready || stopped(), 15_000)
    }
    // Deadline or gave up: end cleanly so the browser retries by itself.
    if (!res.writableEnded) res.end()
  } finally {
    clearInterval(keepAlive)
  }
}

function waitFor(probe: () => unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const poll = setInterval(() => {
      if (probe()) {
        clearInterval(poll)
        resolve(true)
      } else if (Date.now() - t0 > Math.max(0, timeoutMs)) {
        clearInterval(poll)
        resolve(false)
      }
    }, 300)
  })
}

function sseHeaders(res: Response) {
  res.status(200)
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
