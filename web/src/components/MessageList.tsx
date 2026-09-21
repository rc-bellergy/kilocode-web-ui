import DOMPurify from "dompurify"
import { marked } from "marked"
import { useMemo, useState } from "react"
import type { Message, Part, QuestionItem, ToolState } from "../lib/types"
import { useStore } from "../store"
import QuestionForm from "./QuestionForm"

marked.setOptions({ async: false, gfm: true, breaks: true })

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string)
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function Json({ value, label }: { value: unknown; label: string }) {
  const [open, setOpen] = useState(true)
  const text = useMemo(() => {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [value])
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] uppercase tracking-wide text-zinc-500 transition hover:text-zinc-300"
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
          {text}
        </pre>
      )}
    </div>
  )
}

/** VS Code-style display names for tool cards ("bash" renders as "Shell"). */
function toolDisplayName(tool: string): string {
  if (tool === "bash") return "Shell"
  return tool.charAt(0).toUpperCase() + tool.slice(1)
}

function ToolIcon({ tool }: { tool: string }) {
  const p = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  }
  switch (tool) {
    case "bash":
      return (
        <svg {...p}>
          <path d="m4 17 6-6-6-6" />
          <path d="M12 19h8" />
        </svg>
      )
    case "read":
      return (
        <svg {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      )
    case "edit":
      return (
        <svg {...p}>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      )
    case "write":
      return (
        <svg {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M12 18v-6" />
          <path d="m9 15 3 3 3-3" />
        </svg>
      )
    case "glob":
    case "grep":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      )
    case "task":
      return (
        <svg {...p}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    case "webfetch":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
      )
    case "todowrite":
    case "todoread":
      return (
        <svg {...p}>
          <path d="m3 17 2 2 4-4" />
          <path d="m3 7 2 2 4-4" />
          <path d="M13 6h8" />
          <path d="M13 12h8" />
          <path d="M13 18h8" />
        </svg>
      )
    case "suggest":
      return (
        <svg {...p}>
          <path d="M15 14c.2-1 0-1.74-.78-2.42-.91-.8-1.72-1.59-1.72-3.08a5 5 0 0 1 10 0c0 1.49-.81 2.28-1.72 3.08-.78.68-.98 1.42-.78 2.42" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
  }
}

/** Icon slot in the card header: spinner while running, red x on error. */
function ToolStatusIcon({ status, tool }: { status: ToolState["status"]; tool: string }) {
  if (status === "running") {
    return <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
  }
  if (status === "error") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-red-400">
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6M9 9l6 6" />
      </svg>
    )
  }
  return (
    <span className={`shrink-0 ${status === "pending" ? "text-zinc-600" : "text-zinc-400"}`}>
      <ToolIcon tool={tool} />
    </span>
  )
}

type BashToken = { text: string; cls?: string }

// Order matters: strings first (so operators inside quotes are not split),
// then operators, flags (with leading space so "-n" only matches as a flag),
// and $variables / $() command substitution.
const BASH_TOKEN_RE = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(&&|\|\||[|;&><])|(\s--?[A-Za-z][A-Za-z0-9-]*)|(\$[A-Za-z_{][A-Za-z0-9_}]*|\$\()/g

function tokenizeCommand(cmd: string): BashToken[] {
  const tokens: BashToken[] = []
  let last = 0
  for (const m of cmd.matchAll(BASH_TOKEN_RE)) {
    const idx = m.index ?? 0
    if (idx > last) tokens.push({ text: cmd.slice(last, idx) })
    if (m[1]) tokens.push({ text: m[0], cls: "text-amber-300" })
    else if (m[2]) tokens.push({ text: m[0], cls: "text-violet-400" })
    else if (m[3]) tokens.push({ text: m[0], cls: "text-cyan-300" })
    else if (m[4]) tokens.push({ text: m[0], cls: "text-emerald-300" })
    last = idx + m[0].length
  }
  if (last < cmd.length) tokens.push({ text: cmd.slice(last) })
  return tokens
}

function CommandBlock({ command }: { command: string }) {
  const tokens = useMemo(() => tokenizeCommand(command), [command])
  return (
    <pre className="overflow-x-auto text-xs leading-relaxed text-zinc-200">
      <span className="text-sky-400">$ </span>
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </pre>
  )
}

/** Shared card header: (icon) ToolName · description — VS Code parity. */
function ToolCardHeader({ part, status }: { part: Extract<Part, { type: "tool" }>; status: ToolState["status"] }) {
  const title = "title" in part.state ? part.state.title : undefined
  return (
    <div className="flex items-center gap-2">
      <ToolStatusIcon status={status} tool={part.tool} />
      <span
        className={`text-sm font-medium ${status === "error" ? "text-red-300" : "text-zinc-200"}`}
        title={part.tool}
      >
        {toolDisplayName(part.tool)}
      </span>
      {title && (
        <>
          <span className="text-zinc-600">·</span>
          <span className="truncate text-sm text-zinc-500" title={title}>
            {title}
          </span>
        </>
      )}
    </div>
  )
}

function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const state: ToolState = part.state
  const status = state.status

  if (part.tool === "bash") return <BashToolCard part={part} />
  if (part.tool === "suggest") return <SuggestToolCard part={part} />

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
      <ToolCardHeader part={part} status={status} />
      <Json value={state.input} label="input" />
      {status === "completed" && state.output && <Json value={state.output} label="output" />}
      {status === "error" && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950/40 p-2 text-xs text-red-300">
          {state.error}
        </pre>
      )}
    </div>
  )
}

/** Shell card: command and output only, in one terminal block (VS Code parity). */
function BashToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const state: ToolState = part.state
  const status = state.status
  const command = typeof state.input.command === "string" ? state.input.command : null
  const output = status === "completed" ? state.output : undefined

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
      <ToolCardHeader part={part} status={status} />
      {command !== null ? (
        <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
          <CommandBlock command={command} />
          {output !== undefined && output.length > 0 && (
            <pre className="mt-1.5 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
              {output}
            </pre>
          )}
        </div>
      ) : (
        <Json value={state.input} label="input" />
      )}
      {status === "error" && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950/40 p-2 text-xs text-red-300">
          {state.error}
        </pre>
      )}
    </div>
  )
}

/** A suggest action as sent by the agent's `suggest` tool. */
interface SuggestAction {
  label: string
  description?: string
  prompt: string
}

/** Extract the suggestion text and valid actions from a suggest tool part's input. */
function suggestPayload(part: Extract<Part, { type: "tool" }>): { suggest: string; actions: SuggestAction[] } {
  const input = part.state.input as { suggest?: unknown; actions?: unknown }
  const suggest = typeof input.suggest === "string" ? input.suggest : ""
  const actions = Array.isArray(input.actions)
    ? input.actions.filter(
        (a): a is SuggestAction =>
          !!a &&
          typeof a === "object" &&
          typeof (a as SuggestAction).label === "string" &&
          typeof (a as SuggestAction).prompt === "string",
      )
    : []
  return { suggest, actions }
}

/**
 * The agent's `suggest` tool call (a UI affordance, not a permission gate):
 * renders the suggestion text with one button per action. Clicking a button
 * sends its prompt as a new user message to the session — the same path as
 * the composer, with no agent/model override. An action whose prompt is
 * already in the transcript (this click or an earlier one) renders as used.
 */
function SuggestToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const state: ToolState = part.state
  const status = state.status
  const sendPrompt = useStore((s) => s.sendPrompt)
  const messages = useStore((s) => s.messages)
  const sessionStatus = useStore((s) => s.statuses[part.sessionID])
  const [sentLabel, setSentLabel] = useState<string | null>(null)
  const { suggest, actions } = suggestPayload(part)

  const sentPrompts = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages) {
      if (m.info.role !== "user") continue
      for (const p of m.parts) if (p.type === "text") set.add(p.text.trim())
    }
    return set
  }, [messages])

  const busy = sessionStatus?.type === "busy" || sessionStatus?.type === "retry"
  const isUsed = (a: SuggestAction) => sentLabel === a.label || sentPrompts.has(a.prompt.trim())

  async function run(a: SuggestAction) {
    if (isUsed(a) || busy) return
    setSentLabel(a.label)
    await sendPrompt(a.prompt, { agent: null, model: null })
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3" data-testid="suggest-tool-card">
      <ToolCardHeader part={part} status={status} />
      {suggest && <div className="mt-2 text-sm text-zinc-300">{suggest}</div>}
      {actions.length > 0 ? (
        <div className="mt-2.5 space-y-1.5">
          {actions.map((a) => {
            const used = isUsed(a)
            return (
              <button
                key={a.label}
                onClick={() => void run(a)}
                disabled={used || busy}
                className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition ${
                  used
                    ? "border-zinc-800 bg-zinc-950/60 opacity-60"
                    : "border-zinc-700 bg-zinc-950 hover:border-sky-500/60 hover:bg-zinc-900"
                } disabled:cursor-not-allowed`}
                data-testid="suggest-action"
              >
                {used ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="mt-0.5 shrink-0 text-emerald-400"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="mt-0.5 shrink-0 text-sky-400"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                )}
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-zinc-100">
                    {a.label}
                    {used && <span className="ml-1.5 text-xs font-normal text-emerald-400">sent</span>}
                  </span>
                  {a.description && <span className="block text-xs text-zinc-500">{a.description}</span>}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <Json value={state.input} label="input" />
      )}
      {status === "completed" && state.output && <Json value={state.output} label="output" />}
      {status === "error" && (
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-red-950/40 p-2 text-xs text-red-300">
          {state.error}
        </pre>
      )}
    </div>
  )
}

/** Extract the questions list from a question tool part's input. */
function questionItems(part: Extract<Part, { type: "tool" }>): QuestionItem[] {
  const input = part.state?.input as { questions?: QuestionItem[] } | undefined
  return Array.isArray(input?.questions) ? input.questions : []
}

/** Parse a completed question tool output ("{\"answers\":[[…]]}") back into labels. */
function parseAnswers(output: string | undefined): string[][] | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output) as { answers?: unknown }
    if (Array.isArray(parsed.answers) && parsed.answers.every((a) => Array.isArray(a))) {
      return parsed.answers.map((a) => (a as unknown[]).map(String))
    }
  } catch {
    /* formatted text output */
  }
  return null
}

/**
 * The agent's `question` tool call. While a matching question.v2 request is
 * pending this renders the interactive answer form; once answered it shows
 * the chosen options next to each question (VS Code parity).
 */
function QuestionToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const state: ToolState = part.state
  const questions = useStore((s) => s.questions)
  const replyQuestion = useStore((s) => s.replyQuestion)
  const rejectQuestion = useStore((s) => s.rejectQuestion)
  const items = questionItems(part)
  const pending = questions.find(
    (q) => q.sessionID === part.sessionID && q.tool?.callID === part.callID,
  )
  const answers = state.status === "completed" ? parseAnswers(state.output) : null
  const dismissed = state.status === "error"

  if (pending && (state.status === "pending" || state.status === "running")) {
    return <QuestionForm request={pending} onSubmit={(a) => replyQuestion(pending.id, a)} onDismiss={() => rejectQuestion(pending.id)} />
  }

  return (
    <div
      className={`rounded-xl border p-3 ${
        dismissed ? "border-zinc-800 bg-zinc-900/70" : "border-zinc-800 bg-zinc-900/70"
      }`}
      data-testid="question-tool-card"
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
            answers
              ? "bg-emerald-500/15 text-emerald-300"
              : dismissed
                ? "bg-zinc-500/15 text-zinc-400"
                : "bg-sky-500/15 text-sky-300"
          }`}
        >
          {answers ? "answered" : dismissed ? "dismissed" : "question"}
        </span>
        <span className="text-sm font-medium text-zinc-200">
          {items.length > 0 ? `Agent question${items.length > 1 ? `s (${items.length})` : ""}` : part.tool}
        </span>
      </div>
      <div className="mt-2 space-y-2.5">
        {items.map((q, i) => (
          <div key={i}>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{q.header}</div>
            <div className="text-sm text-zinc-200">{q.question}</div>
            {answers ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {(answers[i]?.length ? answers[i] : ["Unanswered"]).map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {label}
                  </span>
                ))}
              </div>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {q.options.map((opt) => (
                  <li key={opt.label} className="text-xs text-zinc-500">
                    • {opt.label}
                    {opt.description ? ` — ${opt.description}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {items.length === 0 && <Json value={state.input} label="input" />}
      </div>
      {dismissed && typeof (state as { error?: string }).error === "string" && (
        <div className="mt-2 rounded-lg bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-400">
          {(state as { error: string }).error}
        </div>
      )}
      {state.status === "completed" && state.output && !answers && <Json value={state.output} label="output" />}
    </div>
  )
}

function PartView({ part, index }: { part: Part; index: number }) {
  switch (part.type) {
    case "text":
      return <Markdown text={part.text} />
    case "reasoning":
      return (
        <details className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2 [&_summary]:cursor-pointer">
          <summary className="text-xs italic text-zinc-500">Reasoning</summary>
          <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-400">{part.text}</div>
        </details>
      )
    case "tool":
      return part.tool === "question" ? <QuestionToolCard part={part} /> : <ToolCard part={part} />
    case "file":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm">
          <span className="text-sky-400">▸</span>
          <span className="truncate text-zinc-300">{part.filename ?? part.url}</span>
          <span className="ml-auto text-xs text-zinc-500">{part.mime}</span>
        </div>
      )
    case "step-start":
      return (
        <div className="flex items-center gap-3 py-1 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          step {index + 1}
          <span className="h-px flex-1 bg-zinc-800" />
        </div>
      )
    case "step-finish":
      return (
        <div className="flex items-center gap-3 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800/60" />
          {part.reason} · {(part.tokens.input + part.tokens.output).toLocaleString()} tok · $
          {part.cost.toFixed(4)}
          <span className="h-px flex-1 bg-zinc-800/60" />
        </div>
      )
    case "agent":
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2.5 py-1 text-xs text-indigo-300">
          mode → {part.name}
        </div>
      )
    case "subtask":
      return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-300">subtask · {part.agent}</div>
          <div className="mt-1 text-sm text-zinc-300">{part.description}</div>
          <Json value={part.prompt} label="prompt" />
        </div>
      )
    case "retry":
      return (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          retry attempt {part.attempt + 1}: {part.error?.message ?? part.error?.name ?? "error"}
        </div>
      )
    case "snapshot":
      return (
        <div className="text-xs text-zinc-600">snapshot {part.snapshot.slice(0, 16)}…</div>
      )
    case "patch":
      return (
        <div className="text-xs text-zinc-600">workspace patched: {part.files.join(", ") || "(no files)"}</div>
      )
    case "compaction":
      return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400">
          context compacted{part.auto ? " (auto)" : ""}
        </div>
      )
    default: {
      const raw = part as unknown as { type: string }
      return <Json value={raw as Record<string, unknown>} label={raw.type} />
    }
  }
}

function MessageView({ message }: { message: Message }) {
  const info = message.info
  const isUser = info.role === "user"

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sky-600/20 px-4 py-2.5">
          {message.parts
            .filter((p) => p.type === "text")
            .map((p) => (
              <div key={p.id} className="whitespace-pre-wrap text-sm text-sky-50">
                {(p as Extract<Part, { type: "text" }>).text}
              </div>
            ))}
        </div>
      </div>
    )
  }

  const error = "error" in info ? info.error : undefined
  const totalTokens =
    info.role === "assistant"
      ? info.tokens.input + info.tokens.output + info.tokens.cache.read + info.tokens.cache.write
      : 0

  return (
    <div className="max-w-full">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-400">{info.agent || info.mode || "assistant"}</span>
        {info.role === "assistant" && (
          <span>
            {info.providerID}/{info.modelID}
          </span>
        )}
        {info.role === "assistant" && info.cost > 0 && (
          <>
            <span>{totalTokens.toLocaleString()} tok</span>
            <span>${info.cost.toFixed(4)}</span>
          </>
        )}
      </div>
      <div className="space-y-2">
        {message.parts.map((part, i) => (
          <PartView key={part.id} part={part} index={i} />
        ))}
      </div>
      {error && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <span className="font-semibold">{error.name}</span>
          {error.message ? `: ${error.message}` : ""}
        </div>
      )}
    </div>
  )
}

export default function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-6">
      {messages.map((m) => (
        <MessageView key={m.info.id} message={m} />
      ))}
    </div>
  )
}

/**
 * True when the transcript already renders a question tool part for this
 * request (its interactive form lives inline); used to decide whether the
 * composer fallback should also render it above the input.
 */
export function hasQuestionPart(messages: Message[], request: { tool?: { callID?: string } }): boolean {
  const callID = request.tool?.callID
  if (!callID) return false
  return messages.some((m) => m.parts.some((p) => p.type === "tool" && p.callID === callID))
}
