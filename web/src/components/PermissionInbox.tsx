import { useEffect, useState } from "react"
import { useStore } from "../store"

export default function PermissionInbox() {
  const permissions = useStore((s) => s.permissions)
  const sessions = useStore((s) => s.sessions)
  const replyPermission = useStore((s) => s.replyPermission)
  const inboxOpen = useStore((s) => s.permissionInboxOpen)
  const setInboxOpen = useStore((s) => s.setPermissionInboxOpen)
  const [open, setOpen] = useState(inboxOpen)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (inboxOpen && !open) setOpen(true)
  }, [inboxOpen, open])

  useEffect(() => {
    if (!open) return
    setInboxOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, setInboxOpen])

  async function reply(id: string, kind: "once" | "always" | "reject") {
    setBusy(id)
    try {
      if (kind === "reject" && rejecting === id && feedback.trim()) {
        await replyPermission(id, "reject", feedback.trim())
      } else {
        await replyPermission(id, kind)
      }
      setRejecting(null)
      setFeedback("")
    } finally {
      setBusy(null)
    }
  }

  function sessionTitle(sessionID: string): string {
    return sessions.find((s) => s.id === sessionID)?.title ?? "session"
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        title="Permission requests"
        className="relative rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-zinc-300 transition hover:border-zinc-500"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        </svg>
        {permissions.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 grid min-w-4 place-items-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-zinc-950">
            {permissions.length}
          </span>
        )}
      </button>

      <button
        onClick={() => void useStore.getState().logout()}
        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
      >
        Sign out
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={() => setOpen(false)}>
          <aside
            className="flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="border-b border-zinc-800 px-4 py-3">
              <h2 className="font-semibold">Permission requests</h2>
              <p className="text-xs text-zinc-500">
                {permissions.length === 0 ? "Nothing pending" : `${permissions.length} pending`}
              </p>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {permissions.length === 0 && (
                <p className="pt-8 text-center text-sm text-zinc-500">
                  No pending permission requests. When Kilo needs approval to run a tool, it appears here.
                </p>
              )}
              {permissions.map((p) => (
                <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
                  <div className="text-sm font-semibold text-amber-300">{p.permission}</div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">{sessionTitle(p.sessionID)}</div>
                  {p.patterns.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.patterns.map((pat) => (
                        <code key={pat} className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-sky-300">
                          {pat}
                        </code>
                      ))}
                    </div>
                  )}
                  {typeof p.metadata?.command === "string" && (
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-950 p-2 text-xs text-zinc-300">
                      {p.metadata.command}
                    </pre>
                  )}
                  {p.metadata &&
                    Object.keys(p.metadata)
                      .filter((k) => k !== "command")
                      .map((k) => {
                        const v = p.metadata?.[k]
                        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return null
                        return (
                          <div key={k} className="mt-1 text-xs text-zinc-400">
                            <span className="text-zinc-500">{k}:</span> {String(v)}
                          </div>
                        )
                      })}

                  {rejecting === p.id ? (
                    <div className="mt-3">
                      <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        placeholder="Optional feedback for the agent…"
                        rows={2}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-sky-500"
                      />
                      <div className="mt-2 flex justify-end gap-2 text-xs">
                        <button onClick={() => setRejecting(null)} className="text-zinc-400 hover:text-zinc-200">
                          Cancel
                        </button>
                        <button
                          onClick={() => void reply(p.id, "reject")}
                          disabled={busy === p.id}
                          className="rounded bg-red-500/90 px-2.5 py-1.5 font-medium text-white hover:bg-red-500 disabled:opacity-40"
                        >
                          Send rejection
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-2 text-xs">
                      <button
                        onClick={() => void reply(p.id, "once")}
                        disabled={busy === p.id}
                        className="flex-1 rounded-lg bg-emerald-500/90 py-1.5 font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void reply(p.id, "always")}
                        disabled={busy === p.id}
                        className="flex-1 rounded-lg border border-emerald-500/40 py-1.5 font-medium text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
                      >
                        Always allow
                      </button>
                      <button
                        onClick={() => setRejecting(p.id)}
                        disabled={busy === p.id}
                        className="flex-1 rounded-lg border border-red-500/40 py-1.5 font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </>
  )
}
