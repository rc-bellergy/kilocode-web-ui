/**
 * Scriptable mock of `kilo serve` for unit + E2E tests.
 *
 * Shapes mirror the real kilo CLI 7.7.5 contract verified in Phase 0
 * (see plan 1789790918230): REST routes, SSE `data:`-only frames,
 * `message.part.delta` streaming, ascending prefixed IDs.
 *
 * In-process use (vitest):
 *   const mock = await startMockKilo({ kiloPort: 0, controlPort: 0 })
 *   mock.kiloUrl / mock.state / await mock.close()
 *
 * Subprocess use (Playwright):
 *   npx tsx server/test/mock-kilo-server.ts --kilo-port 4096 --control-port 4097 [--password secret]
 *   then drive scenarios over the control port (POST /__control/...).
 */
import http from "node:http"
import crypto from "node:crypto"

// ---------------------------------------------------------------- IDs

let ascendingCounter = Math.floor(Math.random() * 0xffffff)
function ascendingHex(): string {
  ascendingCounter += 1 + Math.floor(Math.random() * 3)
  return ascendingCounter.toString(16).padStart(12, "0")
}
const RANDOM_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
function randomTail(len = 14): string {
  let out = ""
  const bytes = crypto.randomBytes(len)
  for (let i = 0; i < len; i++) out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length]
  return out
}
function makeID(prefix: "ses_" | "msg_" | "prt_" | "per_" | "que_" | "evt_"): string {
  return `${prefix}${ascendingHex()}${randomTail()}`
}

// Default question.v2 payload for control-triggered questions.
const DEFAULT_QUESTIONS = [
  {
    question: "Which database should the app use?",
    header: "Database",
    options: [
      { label: "PostgreSQL (Recommended)", description: "Relational, mature ecosystem" },
      { label: "SQLite", description: "Embedded, zero-config" },
    ],
  },
]

// ---------------------------------------------------------------- state

export interface MockSession {
  info: Record<string, unknown>
  directory: string
  messages: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[]
}

export interface MockState {
  projects: Record<string, unknown>[]
  sessions: Map<string, MockSession>
  statuses: Record<string, Record<string, unknown>>
  permissions: Record<string, unknown>[]
  questions: Record<string, unknown>[]
  replies: { requestID: string; reply: string; message?: string }[]
  questionReplies: { requestID: string; answers: string[][] | null; rejected: boolean }[]
  aborts: string[]
  prompts: { sessionID: string; body: Record<string, unknown> }[]
  lastEventIDs: (string | undefined)[]
  eventDelayMs: number
  hung: Set<string>
  sseClients: number
}

function defaultProjects(): Record<string, unknown>[] {
  const now = Date.now()
  return [
    {
      id: "prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      worktree: "/tmp/kilo-e2e/project-a",
      vcs: "git",
      // project-a is the most recently active so the web app's directory
      // fallback lands here, matching createMockSession()'s default scope.
      time: { created: now - 90_000, updated: now - 30_000 },
      sandboxes: ["/tmp/kilo-e2e/project-a"],
    },
    {
      id: "prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2",
      worktree: "/tmp/kilo-e2e/project-b",
      vcs: "git",
      time: { created: now - 80_000, updated: now - 60_000 },
      sandboxes: ["/tmp/kilo-e2e/project-b"],
    },
  ]
}

const AGENTS = [
  { name: "code", displayName: "Code", description: "Write code", mode: "primary", hidden: false, deprecated: false },
  { name: "ask", displayName: "Ask", description: "Answer questions", mode: "primary", hidden: false, deprecated: false },
  { name: "debug", displayName: "Debug", description: "Fix bugs", mode: "primary", hidden: false, deprecated: false },
  { name: "unit-test", displayName: null, description: "Subagent", mode: "subagent", hidden: false, deprecated: false },
]

const PROJECT_B = "/tmp/kilo-e2e/project-b"

// Two providers × three models each. project-b intentionally misses
// "mock-alt" so the /models page and composer dropdown exercise the
// "not in this project" intersection behaviour.
const PROVIDERS_ALL = [
  {
    id: "mock-provider",
    name: "Mock Provider",
    source: "mock",
    models: {
      "mock-tiny": { id: "mock-tiny", providerID: "mock-provider", name: "Mock Tiny", status: "active", limit: { context: 128_000 } },
      "mock-mini": { id: "mock-mini", providerID: "mock-provider", name: "Mock Mini", status: "active", limit: { context: 256_000 } },
      "mock-large": { id: "mock-large", providerID: "mock-provider", name: "Mock Large", status: "active", limit: { context: 1_000_000 } },
    },
  },
  {
    id: "mock-alt",
    name: "Mock Alt",
    source: "mock",
    models: {
      "alt-one": { id: "alt-one", providerID: "mock-alt", name: "Alt One", status: "active", limit: { context: 128_000 } },
      "alt-two": { id: "alt-two", providerID: "mock-alt", name: "Alt Two", status: "active", limit: { context: 128_000 } },
      "alt-three": { id: "alt-three", providerID: "mock-alt", name: "Alt Three", status: "active", limit: { context: 128_000 } },
    },
  },
]

function providersFor(directory: string | null) {
  const all = directory === PROJECT_B ? PROVIDERS_ALL.filter((p) => p.id === "mock-provider") : PROVIDERS_ALL
  return { all, default: { "mock-provider": "mock-tiny" }, connected: all.map((p) => p.id), failed: [] }
}

// ---------------------------------------------------------------- server

export interface MockKilo {
  kiloPort: number
  controlPort: number
  kiloUrl: string
  controlUrl: string
  state: MockState
  close: () => Promise<void>
  emit: (type: string, properties: Record<string, unknown>, directory?: string | null) => void
  reset: () => void
}

interface SseClient {
  res: http.ServerResponse
  directory: string | null
}

export interface MockKiloOptions {
  kiloPort?: number
  controlPort?: number
  password?: string
}

export function startMockKilo(opts: MockKiloOptions = {}): Promise<MockKilo> {
  const password = opts.password ?? null
  const clients = new Set<SseClient>()
  // Clients wedged via /__control/sse-silence: still connected, written to by
  // nothing — simulates a zombie stream (no events, no close, no error).
  const silenced = new Set<SseClient>()
  const replyWaiters = new Map<string, (answers?: string[][]) => void>()
  const heartbeat = new Map<string, NodeJS.Timeout>()

  const state: MockState = {
    projects: defaultProjects(),
    sessions: new Map(),
    statuses: {},
    permissions: [],
    questions: [],
    replies: [],
    questionReplies: [],
    aborts: [],
    prompts: [],
    lastEventIDs: [],
    eventDelayMs: 25,
    hung: new Set(),
    sseClients: 0,
  }

  function sessionDirectory(payload: Record<string, unknown>): string | null | undefined {
    const sid = payload.sessionID as string | undefined
    if (sid && state.sessions.has(sid)) return state.sessions.get(sid)!.directory
    return undefined
  }

  function emit(type: string, properties: Record<string, unknown> = {}, directory?: string | null) {
    const scope = directory ?? sessionDirectory(properties) ?? null
    const frame = `data: ${JSON.stringify({ id: makeID("evt_"), type, properties })}\n\n`
    for (const c of clients) {
      if (silenced.has(c)) continue
      // Faithful to real kilo: project-scoped events only reach clients that
      // subscribed with that directory; a directory-less client gets global
      // (scope-null) events only.
      if (scope === null || c.directory === scope) c.res.write(frame)
    }
  }

  function sleep(): Promise<void> {
    return new Promise((r) => setTimeout(r, state.eventDelayMs))
  }

  function createSession(directory: string): MockSession {
    const now = Date.now()
    const id = makeID("ses_")
    const info = {
      id,
      slug: `mock-${state.sessions.size + 1}`,
      projectID: "global",
      directory,
      path: directory.replace(/^\//, ""),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      title: `New session - ${new Date(now).toISOString()}`,
      version: "7.7.5-mock",
      time: { created: now, updated: now },
    }
    const session: MockSession = { info, directory, messages: [] }
    state.sessions.set(id, session)
    emit("session.created", { sessionID: id, info })
    return session
  }

  // ---- scripted turn -------------------------------------------------

  async function runTurn(session: MockSession, body: Record<string, unknown>) {
    const sessionID = session.info.id as string
    if (state.hung.has(sessionID)) {
      setStatus(sessionID, { type: "busy" })
      return
    }
    const text =
      (Array.isArray(body.parts) && (body.parts as { type: string; text?: string }[]).find((p) => p.type === "text")?.text) || ""
    const wants = (marker: string) => text.includes(marker)

    setStatus(sessionID, { type: "busy" })

    // user message
    const userMsg: MockSession["messages"][number] = {
      info: {
        id: makeID("msg_"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: (body.agent as string) || "code",
        model: { providerID: "mock-provider", modelID: "mock-tiny" },
      },
      parts: [],
    }
    session.messages.push(userMsg)
    emit("message.updated", { sessionID, info: userMsg.info })
    const userText: Record<string, unknown> = { id: makeID("prt_"), sessionID, messageID: userMsg.info.id, type: "text", text }
    userMsg.parts.push(userText)
    emit("message.part.updated", { sessionID, part: userText, time: Date.now() })
    await sleep()

    // assistant message
    const now0 = Date.now()
    const assistant: MockSession["messages"][number] = {
      info: {
        id: makeID("msg_"),
        sessionID,
        role: "assistant",
        time: { created: now0 },
        parentID: userMsg.info.id,
        modelID: "mock-tiny",
        providerID: "mock-provider",
        mode: (body.agent as string) || "code",
        agent: (body.agent as string) || "code",
        path: { cwd: session.directory, root: "/" },
        cost: 0,
        tokens: { total: 100, input: 90, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    }
    session.messages.push(assistant)
    emit("message.updated", { sessionID, info: assistant.info })
    const stepStart = { id: makeID("prt_"), sessionID, messageID: assistant.info.id, type: "step-start" }
    assistant.parts.push(stepStart)
    emit("message.part.updated", { sessionID, part: stepStart, time: Date.now() })
    await sleep()

    // reasoning with deltas
    const reasoningText = "Mock reasoning about the request."
    const reasoning: Record<string, unknown> = {
      id: makeID("prt_"),
      sessionID,
      messageID: assistant.info.id,
      type: "reasoning",
      text: "",
      time: { start: Date.now() },
    }
    assistant.parts.push(reasoning)
    emit("message.part.updated", { sessionID, part: { ...reasoning }, time: Date.now() })
    for (const word of reasoningText.split(" ")) {
      emit("message.part.delta", { sessionID, messageID: assistant.info.id, partID: reasoning.id, field: "text", delta: `${word} ` })
      ;(reasoning.text as string) += `${word} `
      await sleep()
    }
    ;(reasoning.time as { start: number; end?: number }).end = Date.now()
    emit("message.part.updated", { sessionID, part: { ...reasoning }, time: Date.now() })

    // optional tool part
    if (wants("+TOOL") || wants("+TOOLERR")) {
      const tool: Record<string, unknown> = {
        id: makeID("prt_"),
        sessionID,
        messageID: assistant.info.id,
        type: "tool",
        callID: `call${ascendingHex()}${randomTail()}`,
        tool: "bash",
        state: { status: "pending", input: { command: "echo mock" }, raw: "echo mock" },
      }
      assistant.parts.push(tool)
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
      tool.state = { status: "running", input: { command: "echo mock" }, title: "echo mock", time: { start: Date.now() } }
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
      if (wants("+TOOLERR")) {
        tool.state = { status: "error", input: { command: "echo mock" }, error: "mock tool failure", time: { start: Date.now(), end: Date.now() } }
      } else {
        tool.state = {
          status: "completed",
          input: { command: "echo mock" },
          output: "```\nmock tool output\n```",
          title: "echo mock",
          time: { start: Date.now(), end: Date.now() },
        }
      }
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
    }

    if (wants("+FILE")) {
      const file = {
        id: makeID("prt_"),
        sessionID,
        messageID: assistant.info.id,
        type: "file",
        mime: "image/png",
        filename: "chart.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      }
      assistant.parts.push(file)
      emit("message.part.updated", { sessionID, part: file, time: Date.now() })
      await sleep()
    }

    if (wants("+SUBTASK")) {
      const subtask = {
        id: makeID("prt_"),
        sessionID,
        messageID: assistant.info.id,
        type: "subtask",
        prompt: "Do the sub-thing",
        description: "Delegates the sub-thing",
        agent: "unit-test",
      }
      assistant.parts.push(subtask)
      emit("message.part.updated", { sessionID, part: subtask, time: Date.now() })
      await sleep()
    }

    // suggest tool (completes immediately — it is a UI affordance, not a gate)
    if (wants("+SUGGEST")) {
      const input = {
        suggest: "Tool card rework is complete and e2e-verified — consider an independent review pass.",
        actions: [
          { label: "Review changes", description: "Independent review of the new tool card rendering", prompt: "/review uncommitted" },
          { label: "Run tests", description: "Re-run the e2e chat suite", prompt: "npm test e2e/chat.spec.ts" },
        ],
      }
      const tool: Record<string, unknown> = {
        id: makeID("prt_"),
        sessionID,
        messageID: assistant.info.id,
        type: "tool",
        callID: `call${ascendingHex()}${randomTail()}`,
        tool: "suggest",
        state: { status: "pending", input, raw: JSON.stringify(input) },
      }
      assistant.parts.push(tool)
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
      tool.state = {
        status: "completed",
        input,
        output: "Suggested 2 actions",
        title: "suggest",
        time: { start: Date.now(), end: Date.now() },
      }
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
    }

    // permission gate: wait until replied
    if (wants("+PERM")) {
      const request: Record<string, unknown> = {
        id: makeID("per_"),
        sessionID,
        permission: "bash",
        patterns: ["*"],
        metadata: { command: "rm -rf /tmp/kilo-e2e/scratch" },
        always: ["*"],
        tool: { messageID: assistant.info.id, callID: "mock-call" },
      }
      state.permissions.push(request)
      emit("permission.asked", request)
      await new Promise<void>((resolve) => {
        replyWaiters.set(request.id as string, () => resolve())
        setTimeout(resolve, 20_000).unref()
      })
      await sleep()
    }

    // question.v2 gate: ask, wait for reply/reject, then finish the tool part
    if (wants("+Q")) {
      const callID = `call${ascendingHex()}${randomTail()}`
      const questions = wants("+QMULTI")
        ? [
            {
              question: "Which features should land first?",
              header: "Scope",
              multiple: true,
              options: [
                { label: "Auth", description: "Login flow" },
                { label: "Billing", description: "Payments" },
                { label: "Docs", description: "User guide" },
              ],
            },
          ]
        : wants("+QNOCUSTOM")
          ? [
              {
                question: "Ship on Friday?",
                header: "Release",
                custom: false,
                options: [
                  { label: "Yes", description: "Cut the release" },
                  { label: "No", description: "Wait a week" },
                ],
              },
            ]
          : DEFAULT_QUESTIONS
      const tool: Record<string, unknown> = {
        id: makeID("prt_"),
        sessionID,
        messageID: assistant.info.id,
        type: "tool",
        callID,
        tool: "question",
        state: { status: "running", input: { questions }, title: "question", time: { start: Date.now() } },
      }
      assistant.parts.push(tool)
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      const request: Record<string, unknown> = {
        id: makeID("que_"),
        sessionID,
        questions,
        tool: { messageID: assistant.info.id, callID },
      }
      state.questions.push(request)
      emit("question.asked", request)
      const answered = await new Promise<{ answers: string[][] | null }>((resolve) => {
        replyWaiters.set(request.id as string, (answers?: string[][]) => resolve({ answers: answers ?? null }))
        setTimeout(() => resolve({ answers: null }), 20_000).unref()
      })
      if (answered.answers) {
        tool.state = {
          status: "completed",
          input: { questions },
          output: JSON.stringify({ answers: answered.answers }),
          title: "question",
          time: { start: Date.now(), end: Date.now() },
        }
      } else {
        tool.state = {
          status: "error",
          input: { questions },
          error: "The user dismissed this question",
          title: "question",
          time: { start: Date.now(), end: Date.now() },
        }
      }
      emit("message.part.updated", { sessionID, part: { ...tool }, time: Date.now() })
      await sleep()
    }

    // final text with deltas (markdown + XSS probe when requested)
    const replyText = wants("+XSS")
      ? 'ok <script>alert("x")</script> **bold**'
      : wants("+LONG")
        ? `Mock reply: ${"This is a long streaming sentence for scroll testing. ".repeat(40)}done.`
        : "Mock reply: done."
    const answer: Record<string, unknown> = {
      id: makeID("prt_"),
      sessionID,
      messageID: assistant.info.id,
      type: "text",
      text: "",
      time: { start: Date.now() },
    }
    assistant.parts.push(answer)
    emit("message.part.updated", { sessionID, part: { ...answer }, time: Date.now() })
    for (const word of replyText.split(" ")) {
      emit("message.part.delta", { sessionID, messageID: assistant.info.id, partID: answer.id, field: "text", delta: `${word} ` })
      ;(answer.text as string) += `${word} `
      await sleep()
    }
    ;(answer.time as { start: number; end?: number }).end = Date.now()
    emit("message.part.updated", { sessionID, part: { ...answer }, time: Date.now() })

    // step-finish + completed message
    const stepFinish = {
      id: makeID("prt_"),
      sessionID,
      messageID: assistant.info.id,
      type: "step-finish",
      reason: "stop",
      cost: 0.001,
      tokens: { total: 100, input: 90, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    assistant.parts.push(stepFinish)
    emit("message.part.updated", { sessionID, part: stepFinish, time: Date.now() })
    assistant.info.time = { created: now0, completed: Date.now() }
    assistant.info.cost = 0.001
    emit("message.updated", { sessionID, info: { ...assistant.info } })
    setStatus(sessionID, { type: "idle" })
    state.hung.delete(sessionID)
  }

  function setStatus(sessionID: string, status: Record<string, unknown>) {
    if (status.type === "idle") delete state.statuses[sessionID]
    else state.statuses[sessionID] = status
    emit("session.status", { sessionID, status })
  }

  // ---- helpers --------------------------------------------------------

  function json(res: http.ServerResponse, status: number, body: unknown) {
    const data = JSON.stringify(body)
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) })
    res.end(data)
  }

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function authorized(req: http.IncomingMessage): boolean {
    if (!password) return true
    const header = req.headers.authorization
    if (!header?.startsWith("Basic ")) return false
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
    return decoded === `kilo:${password}`
  }

  function kiloHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock")
    const directory = url.searchParams.get("directory")
    void (async () => {
      if (!authorized(req)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }

      // SSE
      if (url.pathname === "/event") {
        state.lastEventIDs.push(req.headers["last-event-id"] as string | undefined)
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        })
        const client: SseClient = { res, directory }
        clients.add(client)
        state.sseClients = clients.size
        res.write(`data: ${JSON.stringify({ id: makeID("evt_"), type: "server.connected", properties: {} })}\n\n`)
        const h = setInterval(() => {
          if (silenced.has(client)) return
          res.write(`data: ${JSON.stringify({ id: makeID("evt_"), type: "server.heartbeat", properties: {} })}\n\n`)
        }, 5_000)
        heartbeat.set(String(h), h)
        const cleanup = () => {
          clients.delete(client)
          silenced.delete(client)
          state.sseClients = clients.size
          clearInterval(h)
        }
        res.on("close", cleanup)
        req.on("close", cleanup)
        return
      }

      if (req.method === "GET" && url.pathname === "/project") {
        // Extra headers let proxy tests assert hop-by-hop/set-cookie filtering.
        res.setHeader("Set-Cookie", "mock=1; Path=/")
        res.setHeader("X-Mock-Header", "yes")
        json(res, 200, state.projects)
        return
      }

      if (url.pathname === "/session" && req.method === "GET") {
        const list = [...state.sessions.values()]
          .filter((s) => !directory || s.directory === directory)
          .sort(
            (a, b) =>
              Number((b.info.time as { updated: number } | undefined)?.updated ?? 0) -
              Number((a.info.time as { updated: number } | undefined)?.updated ?? 0),
          )
          .map((s) => ({ ...s.info, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }))
        json(res, 200, list)
        return
      }
      if (url.pathname === "/session" && req.method === "POST") {
        const session = createSession(directory ?? "/tmp/kilo-e2e/project-a")
        json(res, 200, session.info)
        return
      }
      if (url.pathname === "/session/status" && req.method === "GET") {
        const out: Record<string, unknown> = {}
        for (const [sid, st] of Object.entries(state.statuses)) {
          const s = state.sessions.get(sid)
          if (!directory || !s || s.directory === directory) out[sid] = st
        }
        json(res, 200, out)
        return
      }

      let m = /^\/session\/([^/]+)\/message$/.exec(url.pathname)
      if (m && req.method === "GET") {
        const s = state.sessions.get(m[1])
        if (!s) return json(res, 404, { error: "session not found" })
        json(res, 200, s.messages)
        return
      }
      m = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname)
      if (m && req.method === "POST") {
        const s = state.sessions.get(m[1])
        if (!s) return json(res, 404, { error: "session not found" })
        const body = await readBody(req)
        state.prompts.push({ sessionID: m[1], body })
        res.writeHead(204)
        res.end()
        void runTurn(s, body)
        return
      }
      m = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)
      if (m && req.method === "POST") {
        const s = state.sessions.get(m[1])
        if (!s) return json(res, 404, { error: "session not found" })
        state.aborts.push(m[1])
        if (state.hung.has(m[1])) {
          state.hung.delete(m[1])
          setStatus(m[1], { type: "idle" })
        }
        json(res, 200, true)
        return
      }
      m = /^\/session\/([^/]+)$/.exec(url.pathname)
      if (m && req.method === "DELETE") {
        const s = state.sessions.get(m[1])
        if (!s) return json(res, 404, { error: "session not found" })
        state.sessions.delete(m[1])
        delete state.statuses[m[1]]
        state.hung.delete(m[1])
        emit("session.deleted", { sessionID: m[1], info: s.info })
        json(res, 200, true)
        return
      }

      if (url.pathname === "/permission" && req.method === "GET") {
        const list = state.permissions.filter((p) => {
          if (!directory) return true
          const s = state.sessions.get(p.sessionID as string)
          return s?.directory === directory
        })
        json(res, 200, list)
        return
      }
      m = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname)
      if (m && req.method === "POST") {
        const body = await readBody(req)
        const idx = state.permissions.findIndex((p) => p.id === m![1])
        if (idx === -1) return json(res, 404, { error: "permission not found" })
        const [request] = state.permissions.splice(idx, 1)
        const reply = { requestID: m[1], reply: body.reply as string, message: body.message as string | undefined }
        state.replies.push(reply)
        emit("permission.replied", { sessionID: request.sessionID, requestID: m[1], reply: body.reply })
        replyWaiters.get(m[1])?.()
        replyWaiters.delete(m[1])
        json(res, 200, true)
        return
      }

      if (url.pathname === "/question" && req.method === "GET") {
        const list = state.questions.filter((q) => {
          if (!directory) return true
          const s = state.sessions.get(q.sessionID as string)
          return s?.directory === directory
        })
        json(res, 200, list)
        return
      }
      m = /^\/question\/([^/]+)\/reply$/.exec(url.pathname)
      if (m && req.method === "POST") {
        const body = await readBody(req)
        const answers = Array.isArray(body.answers) ? (body.answers as string[][]) : []
        const idx = state.questions.findIndex((q) => q.id === m![1])
        if (idx === -1) return json(res, 404, { error: "question not found" })
        const [request] = state.questions.splice(idx, 1)
        state.questionReplies.push({ requestID: m[1], answers, rejected: false })
        emit("question.replied", { sessionID: request.sessionID, requestID: m[1], answers })
        replyWaiters.get(m[1])?.(answers)
        replyWaiters.delete(m[1])
        json(res, 200, true)
        return
      }
      m = /^\/question\/([^/]+)\/reject$/.exec(url.pathname)
      if (m && req.method === "POST") {
        const idx = state.questions.findIndex((q) => q.id === m![1])
        if (idx === -1) return json(res, 404, { error: "question not found" })
        const [request] = state.questions.splice(idx, 1)
        state.questionReplies.push({ requestID: m[1], answers: null, rejected: true })
        emit("question.rejected", { sessionID: request.sessionID, requestID: m[1] })
        replyWaiters.get(m[1])?.()
        replyWaiters.delete(m[1])
        json(res, 200, true)
        return
      }

      if (url.pathname === "/agent" && req.method === "GET") {
        json(res, 200, AGENTS)
        return
      }
      if (url.pathname === "/provider" && req.method === "GET") {
        json(res, 200, providersFor(directory))
        return
      }

      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: `mock kilo: no route ${req.method} ${url.pathname}` }))
    })().catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err) })
      else res.end()
    })
  }

  function controlHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://mock")
    void (async () => {
      if (req.method === "GET" && url.pathname === "/__control/state") {
        json(res, 200, {
          projects: state.projects,
          sessions: [...state.sessions.entries()].map(([id, s]) => ({ id, directory: s.directory, info: s.info })),
          statuses: state.statuses,
          permissions: state.permissions,
          questions: state.questions,
          replies: state.replies,
          questionReplies: state.questionReplies,
          aborts: state.aborts,
          prompts: state.prompts,
          lastEventIDs: state.lastEventIDs,
          hung: [...state.hung],
          sseClients: state.sseClients,
        })
        return
      }
      if (req.method !== "POST") return json(res, 405, { error: "POST only" })
      const body = await readBody(req)

      switch (url.pathname) {
        case "/__control/reset": {
          const keepSessions = state.sessions
          state.projects = defaultProjects()
          state.sessions = new Map()
          state.statuses = {}
          state.permissions = []
          state.questions = []
          state.replies = []
          state.questionReplies = []
          state.aborts = []
          state.prompts = []
          state.hung = new Set()
          silenced.clear()
          void keepSessions
          json(res, 200, { ok: true })
          return
        }
        case "/__control/delay": {
          state.eventDelayMs = Number(body.ms ?? 25)
          json(res, 200, { ok: true })
          return
        }
        case "/__control/status": {
          setStatus(String(body.sessionID), (body.status ?? { type: "idle" }) as Record<string, unknown>)
          json(res, 200, { ok: true })
          return
        }
        case "/__control/hang": {
          const sid = String(body.sessionID)
          state.hung.add(sid)
          setStatus(sid, { type: "busy" })
          json(res, 200, { ok: true })
          return
        }
        case "/__control/permission": {
          const request: Record<string, unknown> = {
            id: makeID("per_"),
            sessionID: body.sessionID ?? "ses_external000000000000000000",
            permission: body.permission ?? "bash",
            patterns: body.patterns ?? ["*"],
            metadata: body.metadata ?? { command: "echo needs-approval" },
            always: body.always ?? ["*"],
            tool: body.tool,
          }
          state.permissions.push(request)
          emit("permission.asked", request, (body.directory as string) ?? null)
          json(res, 200, request)
          return
        }
        case "/__control/question": {
          // Standalone question.asked with no transcript tool part —
          // exercises the composer fallback / inbox rendering paths.
          const request: Record<string, unknown> = {
            id: makeID("que_"),
            sessionID: body.sessionID ?? "ses_external000000000000000000",
            questions: body.questions ?? DEFAULT_QUESTIONS,
            tool: body.tool,
          }
          state.questions.push(request)
          emit("question.asked", request, (body.directory as string) ?? null)
          json(res, 200, request)
          return
        }
        case "/__control/event": {
          const props = body.properties as Record<string, unknown> | undefined
          emit(String(body.type), props ?? {}, (body.directory as string) ?? null)
          json(res, 200, { ok: true })
          return
        }
        case "/__control/create-session": {
          const session = createSession((body.directory as string) ?? "/tmp/kilo-e2e/project-a")
          json(res, 200, session.info)
          return
        }
        case "/__control/sse-silence": {
          // Wedge every current SSE client (no heartbeat, no events); new
          // connections behave normally.
          if (body.on) for (const c of clients) silenced.add(c)
          else silenced.clear()
          json(res, 200, { ok: true })
          return
        }
        case "/__control/append-message": {
          // Grow a transcript server-side WITHOUT emitting events —
          // simulates message events lost upstream.
          const sid = String(body.sessionID)
          const s = state.sessions.get(sid)
          if (!s) return json(res, 404, { error: "session not found" })
          const now = Date.now()
          const messageID = makeID("msg_")
          s.messages.push({
            info: {
              id: messageID,
              sessionID: sid,
              role: "assistant",
              time: { created: now, completed: now },
              parentID: "",
              modelID: "mock-tiny",
              providerID: "mock-provider",
              mode: "code",
              agent: "code",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [
              {
                id: makeID("prt_"),
                sessionID: sid,
                messageID,
                type: "text",
                text: String(body.text ?? "silent server-side append"),
                time: { start: now, end: now },
              },
            ],
          })
          json(res, 200, { ok: true })
          return
        }
        case "/__control/exit": {
          json(res, 200, { ok: true })
          setTimeout(() => process.exit(0), 50)
          return
        }
        default:
          json(res, 404, { error: `no control route ${url.pathname}` })
      }
    })().catch((err) => json(res, 500, { error: String(err) }))
  }

  return new Promise<MockKilo>((resolve) => {
    const kiloServer = http.createServer(kiloHandler)
    const controlServer = http.createServer(controlHandler)
    kiloServer.on("close", () => {
      for (const c of clients) c.res.end()
      for (const h of heartbeat.values()) clearInterval(h)
    })
    kiloServer.listen(opts.kiloPort ?? 0, "127.0.0.1", () => {
      controlServer.listen(opts.controlPort ?? 0, "127.0.0.1", () => {
        const kiloPort = (kiloServer.address() as { port: number }).port
        const controlPort = (controlServer.address() as { port: number }).port
        resolve({
          kiloPort,
          controlPort,
          kiloUrl: `http://127.0.0.1:${kiloPort}`,
          controlUrl: `http://127.0.0.1:${controlPort}`,
          state,
          emit,
          reset: () => {
            state.projects = defaultProjects()
            state.sessions = new Map()
            state.statuses = {}
            state.permissions = []
            state.questions = []
            state.replies = []
            state.questionReplies = []
            state.aborts = []
            state.prompts = []
            state.hung = new Set()
          },
          close: () =>
            new Promise<void>((done) => {
              for (const c of clients) c.res.end()
              for (const h of heartbeat.values()) clearInterval(h)
              kiloServer.close(() => done())
              controlServer.close(() => {})
            }),
        })
      })
    })
  })
}

// ---------------------------------------------------------------- CLI entry

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("mock-kilo-server.ts") ?? false
if (isMain) {
  const args = process.argv.slice(2)
  function argValue(name: string): number | undefined {
    const i = args.indexOf(name)
    return i !== -1 ? Number(args[i + 1]) : undefined
  }
  const kiloPort = argValue("--kilo-port") ?? 0
  const controlPort = argValue("--control-port") ?? 0
  const passwordIdx = args.indexOf("--password")
  const password = passwordIdx !== -1 ? args[passwordIdx + 1] : undefined
  const mock = await startMockKilo({ kiloPort, controlPort, password })
  console.log(`mock kilo listening on ${mock.kiloUrl}`)
  console.log(`mock control listening on ${mock.controlUrl}`)
  process.on("SIGTERM", () => void mock.close().then(() => process.exit(0)))
  process.on("SIGINT", () => void mock.close().then(() => process.exit(0)))
}
