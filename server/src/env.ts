import { fileURLToPath } from "node:url"
import dotenv from "dotenv"

// Load the repo-root .env. The relative path resolves correctly from
// server/src, server/dist, and the container layout /app/server/dist (-> /app/.env).
// dotenv never overrides existing variables, so real environment (docker compose
// `environment:`, e2e-spawned env) always wins. A missing .env is silently skipped.
//
// MUST be imported first in index.ts: auth.ts and kilo.ts read env at module
// load time, and ESM evaluates imports depth-first in order.
dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true })
