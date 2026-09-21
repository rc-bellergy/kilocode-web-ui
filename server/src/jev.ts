import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Router } from "express"

/**
 * Jev auto-approve: classify shell-command permission requests with a
 * deterministic blocklist first, then TypeSafe Jev (typesafe/jev-1.13.0)
 * called through the requesty.ai router's OpenAI-compatible API.
 *
 * Single mapping source: classifyScores only fetches the four raw
 * probability scores; `mapRisk` here turns them into low/medium/high.
 * Real calls, JEV_MOCK and the eval harness (scripts/jev-eval-run.ts +
 * scripts/jev-eval-report.ts) all import this module, so the mapping
 * cannot drift.
 *
 * Env (read per request so tests can override):
 *   REQUESTY_JEV_KEY    router API key (required unless JEV_MOCK=1)
 *   JEV_API_URL         OpenAI-compatible base URL
 *                       (default https://router.requesty.ai/v1)
 *   JEV_MODEL_ID        router model id (default typesafe/jev-1.13.0)
 *   JEV_MOCK=1          deterministic synthetic scores, no network/key needed
 *   JEV_TIMEOUT_MS      fetch abort timer (default 20000)
 *   JEV_BLOCKLIST_EXTRA comma-separated extra regexes appended to the blocklist
 *   JEV_T_*             mapRisk thresholds (defaults in loadThresholds)
 *   JEV_AUDIT_MAX_BYTES audit rotation cap (default 5MB)
 */

export const JEV_MODEL_ID = "typesafe/jev-1.13.0"

const JEV_API_URL_DEFAULT = "https://router.requesty.ai/v1"

// ---------------------------------------------------------------- thresholds

export interface JevThresholds {
  tHighDestroys: number
  tHighLeaks: number
  tLowReads: number
  tLowDestroys: number
  tLowLeaks: number
  tLowGlobal: number
}

const DEFAULT_THRESHOLDS: JevThresholds = {
  tHighDestroys: 0.6,
  tHighLeaks: 0.5,
  tLowReads: 0.7,
  tLowDestroys: 0.3,
  tLowLeaks: 0.3,
  tLowGlobal: 0.3,
}

function envNumber(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = Number(env[name])
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt
}

export function loadThresholds(env: NodeJS.ProcessEnv = process.env): JevThresholds {
  return {
    tHighDestroys: envNumber(env, "JEV_T_HIGH_DESTROYS", DEFAULT_THRESHOLDS.tHighDestroys),
    tHighLeaks: envNumber(env, "JEV_T_HIGH_LEAKS", DEFAULT_THRESHOLDS.tHighLeaks),
    tLowReads: envNumber(env, "JEV_T_LOW_READS", DEFAULT_THRESHOLDS.tLowReads),
    tLowDestroys: envNumber(env, "JEV_T_LOW_DESTROYS", DEFAULT_THRESHOLDS.tLowDestroys),
    tLowLeaks: envNumber(env, "JEV_T_LOW_LEAKS", DEFAULT_THRESHOLDS.tLowLeaks),
    tLowGlobal: envNumber(env, "JEV_T_LOW_GLOBAL", DEFAULT_THRESHOLDS.tLowGlobal),
  }
}

export interface JevScores {
  destroys_data: number
  leaks_secrets: number
  changes_global_state: number
  reads_only: number
}

export type JevRisk = "low" | "medium" | "high"

/** Pure score→risk mapping; the only place this decision exists. */
export function mapRisk(scores: JevScores, thresholds: JevThresholds = loadThresholds()): JevRisk {
  if (scores.destroys_data >= thresholds.tHighDestroys || scores.leaks_secrets >= thresholds.tHighLeaks) {
    return "high"
  }
  if (
    scores.reads_only >= thresholds.tLowReads &&
    scores.destroys_data < thresholds.tLowDestroys &&
    scores.leaks_secrets < thresholds.tLowLeaks &&
    scores.changes_global_state < thresholds.tLowGlobal
  ) {
    return "low"
  }
  return "medium"
}

// ---------------------------------------------------------------- redaction

const REDACTIONS: RegExp[] = [
  /\b(?:ghp|gho|ghs)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[bap]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\btoken\s*[=:]\s*[A-Za-z0-9+/=_-]{20,}/gi,
]

/**
 * Best-effort secret scrubbing before the command is sent to the router
 * or written to the audit log. Residual risk: anything not matching these
 * shapes is disclosed as-is (documented in the README).
 */
export function redactSecrets(command: string): string {
  let out = command
  for (const re of REDACTIONS) out = out.replace(re, "«redacted»")
  return out
}

// ---------------------------------------------------------------- blocklist

export interface BlockRule {
  name: string
  re: RegExp
}

const BASE_BLOCKLIST: BlockRule[] = [
  { name: "sudo", re: /\bsudo\b/ },
  { name: "rm-recursive-force", re: /\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/ },
  { name: "git-push-force", re: /\bgit\s+push\s+--force\b(?!\s*-with-lease)/ },
  { name: "git-reset-hard", re: /\bgit\s+reset\s+--hard\b/ },
  { name: "curl-pipe-shell", re: /\b(?:curl|wget)\b[^|;]*\|\s*(?:ba)?sh\b/ },
  { name: "dd", re: /\bdd\b[^;|]*\b(?:of|if)=/ },
  { name: "mkfs", re: /\bmkfs/ },
  { name: "chmod-777-root", re: /\bchmod\s+-R\s+777\s+\// },
  { name: "fork-bomb", re: /:\(\)\s*\{/ },
  { name: "write-dev-disk", re: />\s*\/dev\/sd/ },
  { name: "nuke", re: /\bnuke\b/ },
]

export function loadBlocklist(env: NodeJS.ProcessEnv = process.env): BlockRule[] {
  const extra = env.JEV_BLOCKLIST_EXTRA
  if (!extra) return BASE_BLOCKLIST
  const rules = [...BASE_BLOCKLIST]
  for (const part of extra.split(",")) {
    const source = part.trim()
    if (!source) continue
    try {
      rules.push({ name: `extra:${source}`, re: new RegExp(source) })
    } catch {
      console.warn(`[jev] ignoring invalid JEV_BLOCKLIST_EXTRA regex: ${source}`)
    }
  }
  return rules
}

/** First blocklist rule the (already redacted) command hits, or null. */
export function blocklistMatch(command: string, rules: BlockRule[] = loadBlocklist()): BlockRule | null {
  for (const rule of rules) {
    if (rule.re.test(command)) return rule
  }
  return null
}

// ---------------------------------------------------------------- mock mode

function mockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEV_MOCK === "1" || env.JEV_MOCK === "true"
}

const MOCK_DELAY_MARKER = "slow-marker"
const MOCK_DELAY_MS = 1_500

/**
 * Deterministic synthetic scores (JEV_MOCK=1). Defined here in TS so they
 * flow through the same mapRisk as real scores. High risk is always
 * produced by the blocklist, never by the mock.
 */
export function mockScores(command: string): JevScores {
  if (/gh auth switch|npm install|npm ci|brew install/.test(command)) {
    // medium: clearly global-state-changing, nowhere near high thresholds
    return { destroys_data: 0.05, leaks_secrets: 0.05, changes_global_state: 0.85, reads_only: 0.1 }
  }
  // low: read-only, low everything else
  return { destroys_data: 0.02, leaks_secrets: 0.01, changes_global_state: 0.05, reads_only: 0.95 }
}

// ---------------------------------------------------------------- router call

class JevTimeoutError extends Error {}

const SCORE_KEYS = ["destroys_data", "leaks_secrets", "changes_global_state", "reads_only"] as const

/**
 * The four probability questions, verbatim from the Jev-native assessment
 * definition. Passed as typed "noul" questions in response_format — the
 * router's Jev protocol — so they never become prompt text; the user
 * message stays only the material being judged (the command).
 */
const JEV_QUESTIONS: Record<(typeof SCORE_KEYS)[number], { type: "noul"; instructions: string }> = {
  destroys_data: {
    type: "noul",
    instructions: "Probability that running this deletes, overwrites, or destroys files or stored state.",
  },
  leaks_secrets: {
    type: "noul",
    instructions: "Probability that it sends secrets such as tokens, keys or passwords somewhere they could be exposed.",
  },
  changes_global_state: {
    type: "noul",
    instructions:
      "Probability that it changes state outside the current project, such as account auth, installed packages, or system configuration.",
  },
  reads_only: {
    type: "noul",
    instructions: "Probability that it only reads or prints information and changes nothing.",
  },
}

/** Extract one probability from a noul answer ({noul: 0..1}) or bare number. */
function noulProbability(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
  if (typeof value === "object" && value !== null) {
    const n = (value as Record<string, unknown>).noul
    if (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) return n
  }
  return null
}

function parseAnswers(value: unknown): JevScores | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  const out = {} as JevScores
  for (const key of SCORE_KEYS) {
    const n = noulProbability(v[key])
    if (n === null) return null
    out[key] = n
  }
  return out
}

/** Classify calls are serialized: one in-flight router request at a time. */
let classifyQueue: Promise<unknown> = Promise.resolve()

function runSerial<T>(job: () => Promise<T>): Promise<T> {
  const next = classifyQueue.then(job, job)
  classifyQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function timeoutMs(env: NodeJS.ProcessEnv): number {
  const v = Number(env.JEV_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 20_000
}

/**
 * Fetch the four raw probability scores for an ALREADY REDACTED command
 * from the requesty router. No blocklist/redaction/mapping here — the
 * route and the eval runner own those steps, so raw scores have a single
 * producer and a single consumer (mapRisk).
 */
export async function classifyScores(
  redactedCommand: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ scores: JevScores; model: string }> {
  const limit = timeoutMs(env)
  const base = (env.JEV_API_URL || JEV_API_URL_DEFAULT).replace(/\/+$/, "")
  const modelId = env.JEV_MODEL_ID || JEV_MODEL_ID
  return runSerial(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limit)
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.REQUESTY_JEV_KEY ? { authorization: `Bearer ${env.REQUESTY_JEV_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: redactedCommand }],
          response_format: { type: "questions", questions: JEV_QUESTIONS },
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300)
        throw new Error(`jev router HTTP ${response.status}: ${detail}`)
      }
      const bodyText = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(bodyText)
      } catch {
        throw new Error("jev router returned non-JSON response")
      }
      const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
      let answers: unknown
      try {
        answers = JSON.parse(typeof content === "string" && content ? content : "")
      } catch {
        throw new Error("jev router returned unparseable answers")
      }
      const scores = parseAnswers(answers)
      if (!scores) throw new Error("jev router answers did not contain four valid probabilities")
      const reportedModel = (payload as { model?: unknown }).model
      return { scores, model: typeof reportedModel === "string" && reportedModel ? reportedModel : modelId }
    } catch (err) {
      if (controller.signal.aborted) {
        throw new JevTimeoutError(`jev classification timed out after ${limit}ms`)
      }
      if (err instanceof TypeError) {
        // undici network failures are a bare "fetch failed" — surface the cause
        const cause = err.cause instanceof Error ? ` (${err.cause.message})` : ""
        throw new Error(`jev router unreachable: ${err.message}${cause}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  })
}

async function classify(command: string, env: NodeJS.ProcessEnv): Promise<{ scores: JevScores; model: string }> {
  if (mockEnabled(env)) {
    if (command.includes(MOCK_DELAY_MARKER)) {
      await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS))
    }
    return { scores: mockScores(command), model: `${JEV_MODEL_ID} (mock)` }
  }
  return classifyScores(command, env)
}

// ---------------------------------------------------------------- audit log

// server/src or server/dist — both sit one level below the repo root.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function auditFile(): string {
  const dataDir = process.env.KILO_WEB_DATA_DIR || path.join(repoRoot, "data")
  return path.join(dataDir, "jev-audit.jsonl")
}

function auditMaxBytes(env: NodeJS.ProcessEnv): number {
  const v = Number(env.JEV_AUDIT_MAX_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024
}

interface AuditEntry {
  time: string
  requestID: string
  sessionID?: string
  command: string
  risk?: JevRisk
  error?: string
  scores?: JevScores | null
  source: "jev" | "blocklist" | "mock"
  model?: string
  blockedBy?: string
}

/** Append one audit line; rotate to .jsonl.1 past the cap. Failures only warn. */
export function appendAudit(entry: AuditEntry, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = auditFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      const stat = fs.statSync(file)
      if (stat.size > auditMaxBytes(env)) fs.renameSync(file, `${file}.1`)
    } catch {
      /* ENOENT — first write */
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    console.warn(`[jev] audit write failed: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------- routes

export interface JevVerdict {
  risk: JevRisk
  scores: JevScores | null
  source: "jev" | "blocklist" | "mock"
  model?: string
  blockedBy?: string
}

const MAX_COMMAND_CHARS = 8_192

export const jevRouter: Router = Router()

jevRouter.get("/status", (_req, res) => {
  const mock = mockEnabled()
  res.json({ available: mock || Boolean(process.env.REQUESTY_JEV_KEY), model: JEV_MODEL_ID, mock })
})

jevRouter.post("/classify", (req, res) => {
  const body = req.body as { requestID?: unknown; sessionID?: unknown; command?: unknown }
  const requestID = typeof body.requestID === "string" ? body.requestID : ""
  const sessionID = typeof body.sessionID === "string" ? body.sessionID : undefined
  const command = typeof body.command === "string" ? body.command : ""
  if (!requestID || !command.trim() || command.length > MAX_COMMAND_CHARS) {
    res
      .status(400)
      .json({ error: "requestID must be a non-empty string and command a non-empty string of at most 8192 chars" })
    return
  }

  const env = process.env
  const redacted = redactSecrets(command)
  const auditCommand = redacted.slice(0, 2_000)
  const base = { time: new Date().toISOString(), requestID, sessionID, command: auditCommand }

  // Structural safety net first: a blocklist hit is high risk no matter
  // what Jev would say (adversarial text cannot talk its way past it).
  const blocked = blocklistMatch(redacted)
  if (blocked) {
    appendAudit({ ...base, risk: "high", scores: null, source: "blocklist", blockedBy: blocked.name }, env)
    res.json({ risk: "high", scores: null, source: "blocklist", blockedBy: blocked.name })
    return
  }

  if (!mockEnabled(env) && !env.REQUESTY_JEV_KEY) {
    res.status(503).json({ error: "Jev classification unavailable: REQUESTY_JEV_KEY is not configured" })
    return
  }

  const source = mockEnabled(env) ? "mock" : "jev"
  classify(redacted, env)
    .then(({ scores, model }) => {
      const risk = mapRisk(scores, loadThresholds(env))
      appendAudit({ ...base, risk, scores, source, model }, env)
      res.json({ risk, scores, source, model })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      appendAudit({ ...base, error: message.slice(0, 500), source }, env)
      if (err instanceof JevTimeoutError) {
        res.status(504).json({ error: message })
      } else {
        res.status(502).json({ error: message })
      }
    })
})
