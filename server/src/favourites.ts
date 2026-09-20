import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Router } from "express"

/**
 * kilo-web's own model favourites: a single JSON file under the data dir
 * (KILO_WEB_DATA_DIR, default <repo>/data). Cross-device shared through the
 * docker volume; single-user by design (last write wins).
 */

export interface Favourite {
  providerID: string
  modelID: string
  name?: string
  addedAt: number
}

const MAX_FAVOURITES = 200
const MAX_NAME_CHARS = 200

// server/src or server/dist — both sit one level below the repo root.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function favouritesFile(): string {
  const dataDir = process.env.KILO_WEB_DATA_DIR || path.join(repoRoot, "data")
  return path.join(dataDir, "favourites.json")
}

function isValidItem(item: unknown): item is Favourite {
  if (typeof item !== "object" || item === null) return false
  const f = item as Record<string, unknown>
  return (
    typeof f.providerID === "string" &&
    f.providerID.length > 0 &&
    typeof f.modelID === "string" &&
    f.modelID.length > 0 &&
    (f.name === undefined || (typeof f.name === "string" && f.name.length <= MAX_NAME_CHARS)) &&
    typeof f.addedAt === "number"
  )
}

export function readFavourites(): Favourite[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(favouritesFile(), "utf8")) as { favourites?: unknown }
    if (!Array.isArray(parsed.favourites)) {
      console.warn("[favourites] malformed favourites.json: favourites is not an array; treating as empty")
      return []
    }
    const valid = parsed.favourites.filter(isValidItem)
    if (valid.length !== parsed.favourites.length) {
      console.warn(`[favourites] dropped ${parsed.favourites.length - valid.length} invalid entries from favourites.json`)
    }
    return valid
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[favourites] could not read favourites.json (${err instanceof Error ? err.message : err}); treating as empty`)
    }
    return []
  }
}

/** Validate and normalize a PUT payload; duplicate providerID/modelID keys are dropped. */
export function parseFavourites(body: unknown): { ok: true; favourites: Favourite[] } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" }
  const list = (body as { favourites?: unknown }).favourites
  if (!Array.isArray(list)) return { ok: false, error: "favourites must be an array" }
  const seen = new Set<string>()
  const out: Favourite[] = []
  for (const item of list) {
    if (!isValidItem(item)) return { ok: false, error: "each favourite needs non-empty providerID/modelID strings, optional name (≤200 chars) and numeric addedAt" }
    const key = `${item.providerID}\u0000${item.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  if (out.length > MAX_FAVOURITES) return { ok: false, error: `too many favourites (max ${MAX_FAVOURITES})` }
  return { ok: true, favourites: out }
}

export function writeFavourites(favourites: Favourite[]): void {
  const file = favouritesFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify({ favourites }, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

export const favouritesRouter: Router = Router()

favouritesRouter.get("/", (_req, res) => {
  res.json({ favourites: readFavourites() })
})

favouritesRouter.put("/", (req, res) => {
  const parsed = parseFavourites(req.body)
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error })
    return
  }
  try {
    writeFavourites(parsed.favourites)
  } catch (err) {
    console.warn(`[favourites] write failed: ${err instanceof Error ? err.message : err}`)
    res.status(500).json({ error: "failed to save favourites" })
    return
  }
  res.json({ favourites: parsed.favourites })
})
