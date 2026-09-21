import { useEffect, useState } from "react"
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"
import PermissionInbox from "./components/PermissionInbox"
import Dashboard from "./pages/Dashboard"
import Login from "./pages/Login"
import Models from "./pages/Models"
import Session from "./pages/Session"
import {
  ensurePermission,
  loadNotifyPrefs,
  notificationPermission,
  primeAudio,
  saveNotifyPrefs,
  updateTitleBadge,
  type NotifyPrefs,
} from "./lib/notify"
import { useStore } from "./store"

function BellToggle() {
  const showToast = useStore((s) => s.showToast)
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => loadNotifyPrefs())

  function persist(next: NotifyPrefs) {
    setPrefs(next)
    saveNotifyPrefs(next)
  }

  async function toggle() {
    if (!prefs.enabled) {
      persist({ ...prefs, enabled: true })
      const result = await ensurePermission()
      if (result === "denied") {
        showToast("Notifications blocked — allow them in the browser site settings, then re-enable")
      } else if (result === "unsupported") {
        showToast("This browser does not support notifications; title badge only")
      }
      return
    }
    persist({ ...prefs, enabled: false })
  }

  const perm = notificationPermission()
  const on = prefs.enabled && perm === "granted"

  return (
    <>
      <button
        onClick={() => {
          persist({ ...prefs, sound: !prefs.sound })
          if (!prefs.sound) primeAudio()
        }}
        disabled={!prefs.enabled}
        title={
          !prefs.enabled
            ? "Enable notifications to control sound"
            : prefs.sound
              ? "Mute notification sound"
              : "Play notification sound"
        }
        className={`rounded-lg border p-2 transition ${
          prefs.enabled ? "hover:border-zinc-500" : "cursor-not-allowed opacity-40"
        } ${prefs.enabled && prefs.sound ? "border-sky-500/50 text-sky-300" : "border-zinc-700 text-zinc-300"}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          {prefs.sound ? (
            <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
          ) : (
            <path d="M22 9l-6 6M16 9l6 6" />
          )}
        </svg>
      </button>
      <button
        onClick={() => void toggle()}
        title={
          on
            ? "Notifications on — click to disable"
            : "Enable notifications (agent questions / completion)"
        }
        className={`relative rounded-lg border p-2 transition hover:border-zinc-500 ${
          on ? "border-sky-500/50 text-sky-300" : "border-zinc-700 text-zinc-400"
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {!on && prefs.enabled && (
          <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-400" />
        )}
      </button>
    </>
  )
}

export default function App() {
  const location = useLocation()
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const toast = useStore((s) => s.toast)
  const banner = useStore((s) => s.banner)
  const health = useStore((s) => s.health)
  const sseConnected = useStore((s) => s.sseConnected)
  const init = useStore((s) => s.init)
  const refreshHealth = useStore((s) => s.refreshHealth)
  const permissions = useStore((s) => s.permissions)
  const questions = useStore((s) => s.questions)
  const unreadCompleted = useStore((s) => s.unreadCompleted)
  const directory = useStore((s) => s.directory)
  const setPermissionInboxOpen = useStore((s) => s.setPermissionInboxOpen)

  useEffect(() => {
    void (async () => {
      try {
        const { authenticated } = await (await fetch("/api/auth/session")).json()
        setAuthenticated(Boolean(authenticated))
      } catch {
        setAuthenticated(false)
      }
      setAuthChecked(true)
    })()
  }, [])

  useEffect(() => {
    if (authenticated) void init()
  }, [authenticated, init])

  // Open the permission inbox when arriving via a notification link (?inbox=1).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("inbox") === "1") {
      setPermissionInboxOpen(true)
      params.delete("inbox")
      const qs = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash)
    }
  }, [setPermissionInboxOpen])

  // Poll health while the banner is up, kilo is not ready, or the event
  // stream is down (the last known health may be stale-ready) — including
  // when health is null (backend fully unreachable) so recovery is automatic
  // (P1-6).
  useEffect(() => {
    if (!health || !health.kilo.ready || banner || !sseConnected) {
      const t = setInterval(() => void refreshHealth(), 5_000)
      return () => clearInterval(t)
    }
  }, [health, banner, sseConnected, refreshHealth])

  // Title badge: pending permissions + questions + unviewed completed sessions.
  useEffect(() => {
    updateTitleBadge(permissions.length + questions.length + unreadCompleted.length)
  }, [permissions.length, questions.length, unreadCompleted.length])

  if (location.pathname === "/login") {
    if (authenticated) return <Navigate to="/" replace />
    return <Login onLoggedIn={() => setAuthenticated(true)} />
  }
  if (!authChecked) return null
  if (!authenticated) return <Navigate to="/login" replace />

  return (
    <div className="flex h-full flex-col">
      <header
        data-sse-state={sseConnected ? "connected" : "disconnected"}
        className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2.5 backdrop-blur"
      >
        <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-6 place-items-center rounded bg-gradient-to-br from-sky-400 to-indigo-500 text-[11px] font-bold text-zinc-950">
            K
          </span>
          <span className="hidden sm:inline">Kilo Code Web UI</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          {!sseConnected && directory !== null && (
            <span className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-400">
              events disconnected
            </span>
          )}
          <Link
            to="/models"
            title="Favourites"
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          >
            Models
          </Link>
          <BellToggle />
          <PermissionInbox />
        </div>
      </header>

      {banner && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-300">
          {banner}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/session/:sessionID" element={<Session />} />
          <Route path="/models" element={<Models />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {toast && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-xl">
          {toast}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {permissions.length + questions.length} pending approvals
      </span>
    </div>
  )
}
