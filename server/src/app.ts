import path from "node:path"
import { fileURLToPath } from "node:url"
import cookieParser from "cookie-parser"
import express from "express"
import type { Express } from "express"
import { authRoutes, healthHandler, requireAuth } from "./auth.js"
import { favouritesRouter } from "./favourites.js"
import { ipAllowlist, parseAllowlist } from "./ipAllowlist.js"
import { proxyHandler } from "./proxy.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp(): Express {
  const app = express()
  app.disable("x-powered-by")

  // IP allowlist first, before everything (health, auth, proxy, SPA included).
  // Parsed here so tests can rebuild the app with a different ALLOWED_IPS.
  const allow = parseAllowlist(process.env.ALLOWED_IPS)
  if (allow) app.use(ipAllowlist(allow))

  app.use(cookieParser())

  // Health + auth (JSON bodies); everything else under /api needs a session.
  app.get("/api/health", healthHandler)
  const authRouter = express.Router()
  authRoutes(authRouter)
  app.use("/api/auth", express.json({ limit: "1mb" }), authRouter)
  app.use("/api", requireAuth)

  // kilo-web's own JSON storage (model favourites); auth-gated like /api/kilo.
  app.use("/api/favourites", express.json({ limit: "256kb" }), favouritesRouter)

  // Proxy to kilo serve. Raw body parser so any content type passes through untouched.
  app.use("/api/kilo", express.raw({ type: "*/*", limit: "25mb" }), proxyHandler)

  // Static SPA (production). In dev, Vite serves the frontend itself.
  const webDist = path.join(__dirname, "..", "..", "web", "dist")
  app.use(express.static(webDist))
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next()
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) next()
    })
  })
  return app
}
