import DOMPurify from "dompurify"
import { marked } from "marked"
import { useMemo, useState } from "react"
import type { Message, Part, ToolState } from "../lib/types"

marked.setOptions({ async: false, gfm: true, breaks: true })

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string)
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function Json({ value, label }: { value: unknown; label: string }) {
  const [open, setOpen] = useState(false)
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

function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const state: ToolState = part.state
  const status = state.status
  const badge =
    status === "completed"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "running"
        ? "bg-sky-500/15 text-sky-300"
        : status === "error"
          ? "bg-red-500/15 text-red-300"
          : "bg-zinc-500/15 text-zinc-400"
  const title =
    status === "completed" ? state.title : status === "running" ? (state.title ?? part.tool) : part.tool

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${badge}`}>
          {status === "running" ? "run" : status}
        </span>
        <span className="truncate text-sm font-medium text-zinc-200" title={part.tool}>
          {title}
        </span>
      </div>
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
      return <ToolCard part={part} />
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
