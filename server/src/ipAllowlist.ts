import net from "node:net"
import type { NextFunction, Request, Response } from "express"

/**
 * Parse ALLOWED_IPS ("127.0.0.1,::1,203.0.113.0/24") into a BlockList.
 * Returns null when unset/empty (all sources allowed, backwards compatible).
 * Throws on any invalid entry so a bad config fails loudly at startup.
 * Must be called from createApp(), not module top-level, so tests can flip
 * ALLOWED_IPS between app instances.
 */
export function parseAllowlist(raw: string | undefined): net.BlockList | null {
  if (!raw || raw.trim() === "") return null
  const list = new net.BlockList()
  for (const entry of raw.split(",")) {
    const value = entry.trim()
    if (!value) continue
    const slash = value.indexOf("/")
    const addr = slash === -1 ? value : value.slice(0, slash)
    const family = net.isIP(addr)
    if (family === 0) throw new Error(`ALLOWED_IPS: invalid entry "${value}" (not an IP address)`)
    const type = family === 6 ? ("ipv6" as const) : ("ipv4" as const)
    const maxBits = family === 6 ? 128 : 32
    let bits = -1
    if (slash !== -1) {
      bits = Number(value.slice(slash + 1))
      if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) {
        throw new Error(`ALLOWED_IPS: invalid entry "${value}" (prefix must be 0-${maxBits})`)
      }
    }
    try {
      if (slash === -1) list.addAddress(addr, type)
      else list.addSubnet(addr, bits, type)
    } catch (err) {
      throw new Error(`ALLOWED_IPS: invalid entry "${value}" (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  // An ALLOWED_IPS of only commas/whitespace means "no restrictions" too.
  return list.rules.length > 0 ? list : null
}

/** Strip an IPv6-mapped prefix ("::ffff:203.0.113.5" -> "203.0.113.5"). */
function normalizeAddress(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip
}

/** check() with the address family derived from the string (it defaults to ipv4). */
export function checkAddress(allow: net.BlockList, ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 0) return false
  return allow.check(ip, family === 6 ? "ipv6" : "ipv4")
}

/** Middleware that gates every route (health, auth, proxy, SPA) behind the allowlist. */
export function ipAllowlist(allow: net.BlockList): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const raw = req.socket.remoteAddress
    const ip = raw ? normalizeAddress(raw) : null
    // No remote address (e.g. unix socket) cannot be matched: deny when restricted.
    if (!ip || !checkAddress(allow, ip)) {
      console.warn(`[ipAllowlist] rejected ${req.method} ${req.originalUrl ?? req.url} from ${ip ?? "unknown"}`)
      res.status(403).json({ error: "Forbidden" })
      return
    }
    next()
  }
}
