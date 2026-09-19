import type { KiloEvent } from "./types"

export type EventHandler = (event: KiloEvent) => void
export type OpenHandler = () => void
export type ErrorHandler = () => void

interface Handlers {
  onEvent: EventHandler
  onOpen: OpenHandler
  onError: ErrorHandler
}

// kilo heartbeats every few seconds; anything past this with zero events
// (not even server.heartbeat) means the stream is a zombie.
const DEFAULT_STALE_MS = 60_000
const WATCH_MS = 5_000
const STALE_KEY = "kilo-web.sseStaleMs"

let source: EventSource | null = null
let url: string | null = null
let handlers: Handlers | null = null
let lastEventAt = 0

function staleMs(): number {
  try {
    const v = Number(localStorage.getItem(STALE_KEY))
    if (Number.isFinite(v) && v >= 1_000) return v
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_STALE_MS
}

export function connectEvents(directory: string | null, h: Handlers) {
  handlers = h
  const next = directory
    ? `/api/kilo/event?directory=${encodeURIComponent(directory)}`
    : "/api/kilo/event"
  if (next === url && source) return // already connected to this scope
  url = next
  open()
}

function open() {
  if (!url || !handlers) return
  source?.close()
  const es = new EventSource(url)
  source = es
  lastEventAt = Date.now()

  es.onopen = () => {
    lastEventAt = Date.now()
    handlers?.onOpen()
  }
  es.onerror = () => handlers?.onError()
  es.onmessage = (msg) => {
    lastEventAt = Date.now()
    try {
      const parsed = JSON.parse(msg.data) as KiloEvent
      if (parsed && typeof parsed.type === "string") handlers?.onEvent(parsed)
    } catch {
      /* malformed frame, ignore */
    }
  }
}

/**
 * Zombie-stream recovery: after sleep/wake, a network change, or a wedged
 * upstream, the EventSource can sit open forever without delivering events
 * and without firing onerror (the browser never reconnects on its own).
 * When nothing has arrived recently, rebuild the stream — the fresh
 * server.connected then triggers the store's gap-fill refetch. close()
 * fires no onerror, so the auth-probe error counter is untouched.
 */
export function reconnectIfStale() {
  if (!source || !url || !handlers) return
  if (Date.now() - lastEventAt <= staleMs()) return
  open()
}

export function disconnectEvents() {
  source?.close()
  source = null
}

if (typeof window !== "undefined") {
  setInterval(reconnectIfStale, WATCH_MS)
  // Background-tab timers are throttled; re-check the moment the tab or
  // network comes back (wake-from-sleep is the most common zombie cause).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconnectIfStale()
  })
  window.addEventListener("online", reconnectIfStale)
  window.addEventListener("focus", reconnectIfStale)
}
