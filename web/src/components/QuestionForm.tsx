import { useMemo, useState } from "react"
import type { QuestionRequest } from "../lib/types"

const CUSTOM_KEY = "__custom__"
const CUSTOM_LABEL = "Type your own answer"

export interface QuestionFormProps {
  request: QuestionRequest
  onSubmit: (answers: string[][]) => Promise<void>
  onDismiss: () => Promise<void>
}

/**
 * Interactive answer form for a pending agent question (question.v2).
 * Mirrors the VS Code question UI: radio/checkbox options per question,
 * optional custom typed answer, submit + dismiss.
 */
export default function QuestionForm({ request, onSubmit, onDismiss }: QuestionFormProps) {
  const questions = request.questions ?? []
  const [selections, setSelections] = useState<string[][]>(() => questions.map(() => []))
  const [customTexts, setCustomTexts] = useState<string[]>(() => questions.map(() => ""))
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null)

  const canSubmit = useMemo(
    () =>
      questions.every((_q, i) => {
        const sel = selections[i] ?? []
        if (sel.length === 0) return false
        // Custom-only selections need non-empty text; custom text is trimmed.
        return sel.every((s) => s !== CUSTOM_KEY || customTexts[i]?.trim().length > 0)
      }) && questions.length === selections.length,
    [questions, selections, customTexts],
  )

  function toggle(i: number, label: string, multiple: boolean | undefined) {
    const sel = selections[i] ?? []
    const nextSel: string[] = multiple
      ? sel.includes(label)
        ? sel.filter((s) => s !== label)
        : [...sel, label]
      : [label]
    setSelections((prev) => {
      const copy = prev.slice()
      copy[i] = nextSel
      return copy
    })
    // Selecting a preset clears a typed custom draft; selecting custom keeps it.
    if (label !== CUSTOM_KEY) {
      setCustomTexts((t) => {
        const ct = t.slice()
        ct[i] = ""
        return ct
      })
    }
  }

  async function submit() {
    if (!canSubmit || busy) return
    const answers = questions.map((_q, i) => {
      const sel = selections[i] ?? []
      const resolved = sel.map((s) => (s === CUSTOM_KEY ? (customTexts[i] ?? "").trim() : s))
      // Multiple + custom only counts when the text is filled; presets unchanged.
      return resolved.filter((s) => s.length > 0).map((s) => s.slice(0, 200))
    })
    setBusy("submit")
    try {
      await onSubmit(answers)
    } finally {
      setBusy(null)
    }
  }

  async function dismiss() {
    if (busy) return
    setBusy("dismiss")
    try {
      await onDismiss()
    } finally {
      setBusy(null)
    }
  }

  if (questions.length === 0) return null

  return (
    <div className="space-y-4 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3.5" data-question-id={request.id}>
      {questions.map((q, i) => {
        const multiple = Boolean(q.multiple)
        const allowCustom = q.custom !== false
        const sel = selections[i] ?? []
        return (
          <fieldset key={i} className="min-w-0" data-testid="question-item">
            <div className="flex items-center gap-2">
              <span className="grid size-4 place-items-center text-sky-400">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <circle cx="12" cy="17" r="0.5" fill="currentColor" />
                </svg>
              </span>
              <span className="text-xs font-semibold uppercase tracking-wide text-sky-300">{q.header}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-100">{q.question}</p>
            <div className="mt-2 space-y-1.5">
              {q.options.map((opt) => {
                const checked = sel.includes(opt.label)
                return (
                  <label
                    key={opt.label}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-sm transition ${
                      checked
                        ? "border-sky-500/60 bg-sky-500/10"
                        : "border-zinc-700/70 bg-zinc-900/60 hover:border-zinc-600"
                    }`}
                  >
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`question-${request.id}-${i}`}
                      checked={checked}
                      onChange={() => toggle(i, opt.label, q.multiple)}
                      className="mt-0.5 accent-sky-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-zinc-100">{opt.label}</span>
                      {opt.description && <span className="block text-xs text-zinc-400">{opt.description}</span>}
                    </span>
                  </label>
                )
              })}
              {allowCustom && (
                <label
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 text-sm transition ${
                    sel.includes(CUSTOM_KEY)
                      ? "border-sky-500/60 bg-sky-500/10"
                      : "border-zinc-700/70 bg-zinc-900/60 hover:border-zinc-600"
                  }`}
                >
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={`question-${request.id}-${i}`}
                    checked={sel.includes(CUSTOM_KEY)}
                    onChange={() => toggle(i, CUSTOM_KEY, q.multiple)}
                    className="mt-0.5 accent-sky-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-zinc-300">{CUSTOM_LABEL}</span>
                    {sel.includes(CUSTOM_KEY) && (
                      <input
                        type="text"
                        value={customTexts[i] ?? ""}
                        onChange={(e) =>
                          setCustomTexts((t) => {
                            const ct = t.slice()
                            ct[i] = e.target.value
                            return ct
                          })
                        }
                        placeholder="Your answer…"
                        maxLength={200}
                        data-testid="custom-answer"
                        className="mt-1.5 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500"
                        onClick={(e) => e.preventDefault()}
                      />
                    )}
                  </span>
                </label>
              )}
            </div>
          </fieldset>
        )
      })}
      <div className="flex justify-end gap-2 text-xs">
        <button
          onClick={() => void dismiss()}
          disabled={busy !== null}
          className="rounded-lg border border-zinc-600/60 px-3 py-1.5 font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
        >
          Dismiss
        </button>
        <button
          onClick={() => void submit()}
          disabled={!canSubmit || busy !== null}
          className="rounded-lg bg-sky-500 px-4 py-1.5 font-semibold text-zinc-950 transition hover:bg-sky-400 disabled:opacity-40"
        >
          {busy === "submit" ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  )
}
