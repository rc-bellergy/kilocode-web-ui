import { KeyboardEvent, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import MessageList, { hasQuestionPart } from "../components/MessageList"
import ModeSelect from "../components/ModeSelect"
import ModelSelect from "../components/ModelSelect"
import QuestionForm from "../components/QuestionForm"
import { useStore } from "../store"

export default function Session() {
  const { sessionID } = useParams<{ sessionID: string }>()
  const messages = useStore((s) => s.messages)
  const messagesLoading = useStore((s) => s.messagesLoading)
  const sessions = useStore((s) => s.sessions)
  const statuses = useStore((s) => s.statuses)
  const openSession = useStore((s) => s.openSession)
  const closeSession = useStore((s) => s.closeSession)
  const sendPrompt = useStore((s) => s.sendPrompt)
  const abort = useStore((s) => s.abort)
  const composer = useStore((s) => s.composer)
  const setComposer = useStore((s) => s.setComposer)
  const permissions = useStore((s) => s.permissions)
  const replyPermission = useStore((s) => s.replyPermission)
  const questions = useStore((s) => s.questions)
  const replyQuestion = useStore((s) => s.replyQuestion)
  const rejectQuestion = useStore((s) => s.rejectQuestion)

  const [text, setText] = useState("")
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const [busyPerm, setBusyPerm] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const status = sessionID ? statuses[sessionID] : undefined
  const busy = status?.type === "busy" || status?.type === "retry"
  const session = sessions.find((s) => s.id === sessionID)
  const sessionPermissions = sessionID ? permissions.filter((p) => p.sessionID === sessionID) : []
  // Pending questions whose tool part is not (yet) in the transcript render
  // above the composer; matched ones render inline in the message list.
  const sessionQuestions =
    sessionID && !messagesLoading
      ? questions.filter((q) => q.sessionID === sessionID && !hasQuestionPart(messages, q))
      : []

  async function reply(id: string, kind: "once" | "always" | "reject") {
    setBusyPerm(id)
    try {
      if (kind === "reject" && rejecting === id && feedback.trim()) {
        await replyPermission(id, "reject", feedback.trim())
      } else {
        await replyPermission(id, kind)
      }
      setRejecting(null)
      setFeedback("")
    } finally {
      setBusyPerm(null)
    }
  }

  // Effective composer selection (P1-7): the stored pick wins; otherwise fall
  // back to the session's current agent/model without persisting either way.
  const effectiveSelection = {
    agent: composer.agent ?? session?.agent ?? null,
    model:
      composer.model ??
      (session?.model ? { providerID: session.model.providerID, modelID: session.model.id } : null),
  }

  useEffect(() => {
    if (sessionID) void openSession(sessionID)
    return () => closeSession()
  }, [sessionID, openSession, closeSession])

  // Autoscroll (P0-4): follow new content while streaming — including text
  // growth inside an existing part — but only while stick-to-bottom.
  function onScroll() {
    const el = containerRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const lastMessage = messages[messages.length - 1]
  const streamSignature = `${messages.length}:${lastMessage?.parts.length ?? 0}:${lastMessage?.parts
    .map((p) => ((p as { text?: string }).text?.length ?? 0))
    .join(",")}`
  useEffect(() => {
    if (!stickRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [streamSignature])

// On touch devices (iPad etc.) the on-screen keyboard has no Shift key, so the
// return key must insert a newline; sending happens via the Send button only.
const isTouchDevice =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)")?.matches || navigator.maxTouchPoints > 1)

function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (!isTouchDevice && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

  async function submit() {
    const t = text.trim()
    if (!t || busy || !sessionID) return
    setText("")
    await sendPrompt(t, effectiveSelection)
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-4">
      <div className="flex items-center gap-3 border-b border-zinc-800/70 py-3">
        <Link to="/" className="rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100" title="Back to sessions">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{session?.title ?? "Session"}</h1>
          {session && (
            <p className="truncate text-xs text-zinc-500">
              {session.agent && <span className="text-sky-400/80">{session.agent} · </span>}
              {session.model ? `${session.model.providerID}/${session.model.id}` : ""}
            </p>
          )}
        </div>
        {status?.type === "busy" && (
          <span className="flex items-center gap-1.5 text-xs text-sky-300">
            <span className="size-2 animate-pulse rounded-full bg-sky-400" /> working
          </span>
        )}
        {status?.type === "retry" && <span className="text-xs text-amber-300">retrying…</span>}
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-6" ref={containerRef} onScroll={onScroll}>
        {messagesLoading && messages.length === 0 && (
          <p className="pt-16 text-center text-sm text-zinc-500">Loading transcript…</p>
        )}
        {!messagesLoading && messages.length === 0 && (
          <p className="pt-16 text-center text-sm text-zinc-500">
            Send a message to start working with Kilo.
          </p>
        )}
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </div>

      {sessionQuestions.length > 0 && (
        <div className="space-y-3 border-t border-sky-500/30 py-3">
          {sessionQuestions.map((q) => (
            <QuestionForm
              key={q.id}
              request={q}
              onSubmit={(answers) => replyQuestion(q.id, answers)}
              onDismiss={() => rejectQuestion(q.id)}
            />
          ))}
        </div>
      )}

      {sessionPermissions.length > 0 && (
        <div className="space-y-3 border-t border-amber-500/30 py-3">
          {sessionPermissions.map((p) => (
            <div key={p.id} className="rounded-xl border border-amber-500/50 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2">
                <span className="size-2 animate-pulse rounded-full bg-amber-400" />
                <span className="text-sm font-semibold text-amber-300">
                  Agent needs approval — {p.permission}
                </span>
              </div>
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
                      disabled={busyPerm === p.id}
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
                    disabled={busyPerm === p.id}
                    className="flex-1 rounded-lg bg-emerald-500/90 py-1.5 font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void reply(p.id, "always")}
                    disabled={busyPerm === p.id}
                    className="flex-1 rounded-lg border border-emerald-500/40 py-1.5 font-medium text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-40"
                  >
                    Always allow
                  </button>
                  <button
                    onClick={() => setRejecting(p.id)}
                    disabled={busyPerm === p.id}
                    className="flex-1 rounded-lg border border-red-500/40 py-1.5 font-medium text-red-300 transition hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-zinc-800/70 py-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            isTouchDevice ? "Message Kilo… (return inserts a newline; use Send)" : "Message Kilo… (Enter to send, Shift+Enter for newline)"
          }
          rows={3}
          className="w-full resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-sky-500"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ModeSelect
            value={effectiveSelection.agent}
            onChange={(agent) => setComposer({ ...composer, agent })}
          />
          <ModelSelect
            value={effectiveSelection.model}
            onChange={(model) => setComposer({ ...composer, model })}
          />
          <div className="ml-auto flex items-center gap-2">
            {busy ? (
              <button
                onClick={() => void abort()}
                className="rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-300 transition hover:bg-red-500/10"
              >
                Abort
              </button>
            ) : (
              <button
                onClick={() => void submit()}
                disabled={!text.trim()}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-sky-400 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
