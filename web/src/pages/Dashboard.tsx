import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import ProjectSelect from "../components/ProjectSelect"
import { useStore } from "../store"

function timeAgo(ts: number): string {
  if (!ts) return ""
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function StatusChip({ status }: { status?: { type: string } }) {
  if (!status) return null
  if (status.type === "busy") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
        <span className="size-2 animate-pulse rounded-full bg-sky-400" /> busy
      </span>
    )
  }
  if (status.type === "retry") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
        <span className="size-2 animate-pulse rounded-full bg-amber-400" /> retrying
      </span>
    )
  }
  if (status.type === "offline") {
    return <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-300">offline</span>
  }
  return null
}

export default function Dashboard() {
  const sessions = useStore((s) => s.sessions)
  const statuses = useStore((s) => s.statuses)
  const directory = useStore((s) => s.directory)
  const createSession = useStore((s) => s.createSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  async function newSession() {
    if (busy) return
    setBusy(true)
    const id = await createSession()
    setBusy(false)
    if (id) navigate(`/session/${id}`)
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Sessions</h1>
          <p className="text-sm text-zinc-500">{directory ?? "no project"}</p>
        </div>
        <div className="flex items-center gap-2">
          <ProjectSelect />
          <button
            onClick={() => void newSession()}
            disabled={busy}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-sky-400 disabled:opacity-40"
          >
            + New session
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center text-zinc-500">
          No sessions yet. Create one to start chatting with Kilo.
        </div>
      ) : (
        <ul className="space-y-2">
          {sessions.map((s) => {
            const status = statuses[s.id]
            return (
              <li
                key={s.id}
                className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-zinc-700"
              >
                <Link to={`/session/${s.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-zinc-100">{s.title || "Untitled session"}</span>
                    <StatusChip status={status} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                    {s.agent && <span className="text-sky-400/80">{s.agent}</span>}
                    {s.model && (
                      <span>
                        {s.model.providerID}/{s.model.id}
                      </span>
                    )}
                    {typeof s.cost === "number" && s.cost > 0 && <span>${s.cost.toFixed(4)}</span>}
                    {s.tokens && (
                      <span>
                        {(s.tokens.input + s.tokens.output + s.tokens.cache.read).toLocaleString()} tok
                      </span>
                    )}
                    <span>{timeAgo(s.time.updated)}</span>
                  </div>
                </Link>
                {confirmDelete === s.id ? (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      onClick={() => {
                        void deleteSession(s.id)
                        setConfirmDelete(null)
                      }}
                      className="rounded bg-red-500/90 px-2.5 py-1.5 font-medium text-white hover:bg-red-500"
                    >
                      Delete
                    </button>
                    <button onClick={() => setConfirmDelete(null)} className="text-zinc-400 hover:text-zinc-200">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(s.id)}
                    title="Delete session"
                    className="rounded-lg p-2 text-zinc-600 opacity-0 transition hover:bg-zinc-800 hover:text-red-400 group-hover:opacity-100"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
