import { create } from "zustand"
import { api, ApiError } from "./lib/api"
import { connectEvents, disconnectEvents } from "./lib/events"
import { loadNotifyPrefs, systemNotify } from "./lib/notify"
import type {
  Agent,
  Health,
  KiloEvent,
  Message,
  MessageInfo,
  Part,
  PermissionRequest,
  Project,
  ProviderInfo,
  QuestionRequest,
  SessionInfo,
  SessionStatus,
} from "./lib/types"

export interface ComposerSelection {
  agent: string | null
  model: { providerID: string; modelID: string } | null
}

interface AppState {
  // bootstrap
  booted: boolean
  health: Health | null
  sseConnected: boolean

  // project scope
  projects: Project[]
  directory: string | null

  // reference data
  agents: Agent[]
  providers: ProviderInfo[]
  defaultModelIDs: Record<string, string>

  // live data
  sessions: SessionInfo[]
  statuses: Record<string, SessionStatus>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]

  // open session
  openSessionID: string | null
  messages: Message[]
  messagesLoading: boolean

  // composer selection (persisted)
  composer: ComposerSelection

  // transient ui state
  banner: string | null
  toast: string | null
  permissionInboxOpen: boolean
  unreadCompleted: string[]

  // actions
  init: () => Promise<void>
  refreshHealth: () => Promise<void>
  refreshProjects: () => Promise<void>
  setDirectory: (dir: string | null) => void
  refreshSessions: () => Promise<void>
  refreshPermissions: () => Promise<void>
  refreshStatuses: () => Promise<void>
  refreshAgentsAndProviders: () => Promise<void>
  openSession: (id: string) => Promise<void>
  closeSession: () => void
  createSession: () => Promise<string | null>
  deleteSession: (id: string) => Promise<void>
  sendPrompt: (text: string, selection: ComposerSelection) => Promise<void>
  abort: () => Promise<void>
  replyPermission: (requestID: string, reply: "once" | "always" | "reject", message?: string) => Promise<void>
  refreshQuestions: () => Promise<void>
  replyQuestion: (requestID: string, answers: string[][]) => Promise<void>
  rejectQuestion: (requestID: string) => Promise<void>
  setComposer: (selection: ComposerSelection) => void
  logout: () => Promise<void>
  showToast: (msg: string) => void
  setPermissionInboxOpen: (open: boolean) => void
  handleEvent: (event: KiloEvent) => void
}

const AGENT_KEY = "kilo-web.agent"
const MODEL_KEY = "kilo-web.model"

function loadStoredSelection(): ComposerSelection {
  try {
    const agent = localStorage.getItem(AGENT_KEY) || null
    const rawModel = localStorage.getItem(MODEL_KEY)
    const model = rawModel ? (JSON.parse(rawModel) as { providerID: string; modelID: string }) : null
    return { agent, model }
  } catch {
    return { agent: null, model: null }
  }
}

function saveStoredSelection(selection: ComposerSelection) {
  try {
    if (selection.agent) localStorage.setItem(AGENT_KEY, selection.agent)
    else localStorage.removeItem(AGENT_KEY)
    if (selection.model) localStorage.setItem(MODEL_KEY, JSON.stringify(selection.model))
    else localStorage.removeItem(MODEL_KEY)
  } catch {
    /* storage unavailable */
  }
}

function upsertMessage(messages: Message[], info: MessageInfo): Message[] {
  const idx = messages.findIndex((m) => m.info.id === info.id)
  if (idx === -1) {
    return [...messages, { info, parts: [] }].sort((a, b) => a.info.id.localeCompare(b.info.id))
  }
  const next = messages.slice()
  next[idx] = { ...next[idx], info }
  return next
}

function upsertPart(messages: Message[], part: Part): Message[] {
  const idx = messages.findIndex((m) => m.info.id === part.messageID)
  if (idx === -1) {
    // Part arrived before message.updated: create a shell to fill in later.
    const shell: Message = {
      info: {
        id: part.messageID,
        sessionID: part.sessionID,
        role: "assistant",
        time: { created: 0 },
        parentID: "",
        modelID: "",
        providerID: "",
        mode: "",
        agent: "",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [part],
    }
    return [...messages, shell].sort((a, b) => a.info.id.localeCompare(b.info.id))
  }
  const msg = messages[idx]
  const pIdx = msg.parts.findIndex((p) => p.id === part.id)
  const parts = pIdx === -1 ? [...msg.parts, part] : msg.parts.map((p) => (p.id === part.id ? part : p))
  parts.sort((a, b) => a.id.localeCompare(b.id))
  const next = messages.slice()
  next[idx] = { ...msg, parts }
  return next
}

function removePart(messages: Message[], messageID: string, partID: string): Message[] {
  return messages.map((m) =>
    m.info.id === messageID ? { ...m, parts: m.parts.filter((p) => p.id !== partID) } : m,
  )
}

/**
 * Merge kilo's git-project registry with directories that only have sessions.
 * Directories without a git repo never register a project (their sessions are
 * filed under the "global" catch-all), so synthesize a project entry per
 * orphan session directory. Also dedupes registry rows that share a worktree.
 */
function mergeProjects(projects: Project[], orphanSessions: SessionInfo[]): Project[] {
  const byWorktree = new Map<string, Project>()
  for (const p of projects) {
    const existing = byWorktree.get(p.worktree)
    if (!existing || (p.time?.updated ?? 0) > (existing.time?.updated ?? 0)) byWorktree.set(p.worktree, p)
  }
  for (const s of orphanSessions) {
    const dir = s.directory
    if (!dir || byWorktree.has(dir)) continue
    byWorktree.set(dir, {
      id: `orphan:${dir}`,
      worktree: dir,
      time: { created: s.time?.created ?? 0, updated: s.time?.updated ?? 0 },
      sandboxes: [],
    })
  }
  return [...byWorktree.values()]
}

/** Append a streaming delta to a part's text field (message.part.delta). */
function applyPartDelta(messages: Message[], messageID: string, partID: string, field: string, delta: string): Message[] {
  let touched = false
  const next = messages.map((m) => {
    if (m.info.id !== messageID) return m
    const pIdx = m.parts.findIndex((p) => p.id === partID)
    if (pIdx === -1) {
      // Delta before the part snapshot: create a minimal text part shell.
      touched = true
      const shell = { id: partID, sessionID: m.info.sessionID, messageID, type: "text", text: field === "text" ? delta : "" } as Part
      return { ...m, parts: [...m.parts, shell] }
    }
    touched = true
    const parts = m.parts.slice()
    const part = parts[pIdx] as Record<string, unknown>
    parts[pIdx] = { ...part, [field]: String(part[field] ?? "") + delta } as Part
    return { ...m, parts }
  })
  return touched ? next : messages
}

export const useStore = create<AppState>((set, get) => ({
  booted: false,
  health: null,
  sseConnected: false,
  projects: [],
  directory: null,
  agents: [],
  providers: [],
  defaultModelIDs: {},
  sessions: [],
  statuses: {},
  permissions: [],
  questions: [],
  openSessionID: null,
  messages: [],
  messagesLoading: false,
  composer: loadStoredSelection(),
  banner: null,
  toast: null,
  permissionInboxOpen: false,
  unreadCompleted: [],

  async init() {
    startBusyMessagePoll(set, get)
    await get().refreshHealth()
    await get().refreshProjects()
    await Promise.all([
      get().refreshSessions(),
      get().refreshPermissions(),
      get().refreshQuestions(),
      get().refreshAgentsAndProviders(),
    ])
    get().setDirectory(get().directory)
    set({ booted: true })
  },

  async refreshHealth() {
    try {
      const health = await api.get.health()
      set({ health, banner: health.kilo.ready ? null : (health.kilo.error ?? "kilo server is starting…") })
    } catch (err) {
      set({ banner: `Backend unreachable: ${errText(err)}` })
    }
  },

  async refreshProjects() {
    try {
      // The /project registry only contains git-resolvable directories; a
      // directory-less session listing adds orphan dirs (non-git projects).
      const [projects, orphans] = await Promise.all([
        api.get.projects(),
        api.get.sessions(null).catch(() => [] as SessionInfo[]),
      ])
      // Default to the most recently active project; stale entries (deleted
      // directories) sit at the top of the raw list and fail server-side.
      const byActivity = mergeProjects(projects, orphans).sort(
        (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
      )
      const fallback = get().directory ?? byActivity[0]?.worktree ?? null
      set({ projects: byActivity })
      if (fallback !== get().directory) {
        // Late-learned directory (kilo was not ready when the app booted):
        // the event stream is still connected WITHOUT a directory and never
        // receives project-scoped message events — re-point it. A plain
        // set() would leave the stream scoped wrong until a manual reload.
        get().setDirectory(fallback)
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) get().showToast(errText(err))
    }
  },

  setDirectory(dir: string | null) {
    set({ directory: dir })
    void get().refreshSessions()
    void get().refreshPermissions()
    void get().refreshQuestions()
    void get().refreshStatuses()
    // Per-worktree agents/models can differ; refetch on switch (P1-5).
    void get().refreshAgentsAndProviders()
    connectEvents(dir, {
      onOpen: () => {
        // Transport-level open only: the proxy may be holding this
        // connection open while kilo is down. sseConnected flips true only
        // when the real upstream sends server.connected.
        sseErrorCount = 0
      },
      onError: () => {
        set({ sseConnected: false })
        // P1-4: a dead session cookie makes SSE retry forever; after a few
        // consecutive failures probe auth and redirect to /login if expired.
        sseErrorCount++
        if (sseErrorCount >= 3) {
          sseErrorCount = 0
          void (async () => {
            try {
              const res = await fetch("/api/auth/session")
              const body = (await res.json()) as { authenticated?: boolean }
              if (!body.authenticated && !window.location.pathname.startsWith("/login")) {
                window.location.href = "/login"
              }
            } catch {
              /* backend unreachable, not an auth problem */
            }
          })()
        }
      },
      onEvent: (event) => get().handleEvent(event),
    })
  },

  async refreshSessions() {
    const { directory } = get()
    try {
      const sessions = await api.get.sessions(directory)
      set({ sessions: sessions.sort((a, b) => b.time.updated - a.time.updated) })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) get().showToast(errText(err))
    }
  },

  async refreshStatuses() {
    const { directory } = get()
    try {
      const statuses = await api.get.statuses(directory)
      set({ statuses })
    } catch {
      /* transient */
    }
  },

  async refreshPermissions() {
    const { directory } = get()
    try {
      const permissions = await api.get.permissions(directory)
      set({ permissions })
    } catch {
      /* transient */
    }
  },

  async refreshQuestions() {
    const { directory } = get()
    try {
      const questions = await api.get.questions(directory)
      set({ questions })
    } catch {
      /* transient */
    }
  },

  async refreshAgentsAndProviders() {
    const { directory } = get()
    try {
      const [agents, providers] = await Promise.all([api.get.agents(directory), api.get.providers(directory)])
      set({ agents, providers: providers.all, defaultModelIDs: providers.default })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) get().showToast(errText(err))
    }
  },

  async openSession(id) {
    lastOpenSessionEventAt = Date.now()
    // Only a genuine switch to a different session drops the pick; a fresh
    // boot (openSessionID null, e.g. page reload) keeps the stored selection.
    const switching = get().openSessionID !== null && get().openSessionID !== id
    set({
      openSessionID: id,
      messages: [],
      messagesLoading: true,
      unreadCompleted: get().unreadCompleted.filter((x) => x !== id),
      // Opening a different session drops any pick made in the previous one so
      // the mode/model menus follow this session's own agent/model.
      ...(switching ? { composer: { agent: null, model: null } } : {}),
    })
    if (switching) saveStoredSelection({ agent: null, model: null })
    // P1-7: session defaults are NOT written into the composer; the effective
    // agent/model is computed at send/render time from the stored selection.
    await refreshOpenMessages(set, get)
    set({ messagesLoading: false })
  },

  closeSession() {
    set({ openSessionID: null, messages: [] })
  },

  async createSession() {
    const { directory } = get()
    try {
      const session = await api.post.createSession(directory)
      set((s) => ({ sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)] }))
      return session.id
    } catch (err) {
      get().showToast(errText(err))
      return null
    }
  },

  async deleteSession(id) {
    const { directory } = get()
    try {
      await api.del.session(directory, id)
      set((s) => ({
        sessions: s.sessions.filter((x) => x.id !== id),
        statuses: Object.fromEntries(Object.entries(s.statuses).filter(([k]) => k !== id)),
      }))
      if (get().openSessionID === id) get().closeSession()
    } catch (err) {
      get().showToast(errText(err))
    }
  },

  async sendPrompt(text, selection) {
    const { directory, openSessionID } = get()
    if (!openSessionID || !text.trim()) return
    try {
      await api.post.promptAsync(directory, openSessionID, {
        agent: selection.agent ?? undefined,
        model: selection.model ?? undefined,
        parts: [{ type: "text", text }],
      })
    } catch (err) {
      get().showToast(errText(err))
    }
  },

  async abort() {
    const { directory, openSessionID } = get()
    if (!openSessionID) return
    try {
      await api.post.abort(directory, openSessionID)
    } catch (err) {
      get().showToast(errText(err))
    }
  },

  async replyPermission(requestID, reply, message) {
    const { directory } = get()
    set((s) => ({ permissions: s.permissions.filter((p) => p.id !== requestID) }))
    try {
      await api.post.permissionReply(directory, requestID, reply, message)
    } catch (err) {
      get().showToast(errText(err))
      await get().refreshPermissions()
    }
  },

  async replyQuestion(requestID, answers) {
    const { directory } = get()
    set((s) => ({ questions: s.questions.filter((q) => q.id !== requestID) }))
    try {
      await api.post.questionReply(directory, requestID, answers)
    } catch (err) {
      get().showToast(errText(err))
      await get().refreshQuestions()
    }
  },

  async rejectQuestion(requestID) {
    const { directory } = get()
    set((s) => ({ questions: s.questions.filter((q) => q.id !== requestID) }))
    try {
      await api.post.questionReject(directory, requestID)
    } catch (err) {
      get().showToast(errText(err))
      await get().refreshQuestions()
    }
  },

  setComposer(selection) {
    saveStoredSelection(selection)
    set({ composer: selection })
  },

  async logout() {
    disconnectEvents()
    try {
      await api.post.logout()
    } catch {
      /* ignore */
    }
    window.location.href = "/login"
  },

  showToast(msg) {
    set({ toast: msg })
    setTimeout(() => {
      if (get().toast === msg) set({ toast: null })
    }, 4000)
  },

  setPermissionInboxOpen(open) {
    set({ permissionInboxOpen: open })
  },

  handleEvent(event) {
    const { openSessionID } = get()
    const p = event.properties
    // Liveness of the open session's event stream (message.*/session.status
    // all carry sessionID); the busy-poll fallback backs off while fresh.
    if (openSessionID && p.sessionID === openSessionID) lastOpenSessionEventAt = Date.now()
    switch (event.type) {
      case "server.connected":
        set({ sseConnected: true })
        // The upstream stream is really established: refetch live data in
        // case the connection was held open across a kilo restart.
        gapFill(set, get)
        break
      case "server.heartbeat":
        break
      case "session.created":
      case "session.updated": {
        const info = p.info as SessionInfo
        if (!info) break
        set((s) => {
          const rest = s.sessions.filter((x) => x.id !== info.id)
          return { sessions: [info, ...rest].sort((a, b) => b.time.updated - a.time.updated) }
        })
        break
      }
      case "session.deleted": {
        const id = (p.sessionID ?? (p.info as SessionInfo | undefined)?.id) as string | undefined
        if (!id) break
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== id),
          unreadCompleted: s.unreadCompleted.filter((x) => x !== id),
        }))
        notifiedBusyCycles.delete(id)
        if (get().openSessionID === id) get().closeSession()
        break
      }
      case "session.status": {
        const id = p.sessionID as string
        const status = p.status as SessionStatus
        if (!id || !status) break
        const prev = get().statuses[id]
        // Completion notification (feature F): busy/retry → idle fires once
        // per busy cycle. Initial idle (no previous busy state) stays silent.
        if ((prev?.type === "busy" || prev?.type === "retry") && status.type === "idle") {
          if (notifiedBusyCycles.has(id)) {
            notifiedBusyCycles.delete(id)
            const title = get().sessions.find((s) => s.id === id)?.title ?? "session"
            if (get().openSessionID !== id) {
              set((s) => ({ unreadCompleted: [...s.unreadCompleted, id] }))
            }
            systemNotify(`Agent done: ${title}`, { tag: `kilo-done-${id}`, onClick: () => window.location.assign(`/session/${id}`) }, loadNotifyPrefs())
          }
        }
        if (status.type === "busy" || status.type === "retry") notifiedBusyCycles.add(id)
        set((s) => ({ statuses: { ...s.statuses, [id]: status } }))
        break
      }
      case "message.updated": {
        const info = p.info as MessageInfo
        if (info && info.sessionID === openSessionID) {
          set((s) => ({ messages: upsertMessage(s.messages, info) }))
        }
        break
      }
      case "message.removed": {
        const messageID = p.messageID as string
        if (p.sessionID === openSessionID && messageID) {
          set((s) => ({ messages: s.messages.filter((m) => m.info.id !== messageID) }))
        }
        break
      }
      case "message.part.updated": {
        const part = p.part as Part
        if (part && part.sessionID === openSessionID) {
          set((s) => ({ messages: upsertPart(s.messages, part) }))
        }
        break
      }
      case "message.part.delta": {
        // Real-time streaming (P0-V3): append incremental text to the part.
        if (p.sessionID === openSessionID) {
          const messageID = p.messageID as string
          const partID = p.partID as string
          const field = (p.field as string) ?? "text"
          const delta = (p.delta as string) ?? ""
          if (messageID && partID && delta) {
            set((s) => ({ messages: applyPartDelta(s.messages, messageID, partID, field, delta) }))
          }
        }
        break
      }
      case "message.part.removed": {
        if (p.sessionID === openSessionID) {
          set((s) => ({ messages: removePart(s.messages, p.messageID as string, p.partID as string) }))
        }
        break
      }
      case "permission.asked": {
        const request = p as unknown as PermissionRequest
        const title = get().sessions.find((s) => s.id === request.sessionID)?.title ?? "session"
        get().showToast(`Permission needed: ${request.permission ?? "unknown"}`)
        systemNotify(
          `Agent needs approval`,
          {
            body: `${request.permission ?? "unknown"} — ${title}${
              typeof request.metadata?.command === "string" ? `\n${String(request.metadata.command).split("\n")[0]}` : ""
            }`,
            tag: `kilo-perm-${request.id ?? ""}`,
            onClick: () => window.location.assign("/?inbox=1"),
          },
          loadNotifyPrefs(),
        )
        void get().refreshPermissions()
        break
      }
      case "permission.replied":
        void get().refreshPermissions()
        break
      // Real kilo emits question.asked/replied/rejected (@/question); older
      // core builds emit question.v2.* — listen for both shapes.
      case "question.asked":
      case "question.v2.asked": {
        const request = p as unknown as QuestionRequest
        const title = get().sessions.find((s) => s.id === request.sessionID)?.title ?? "session"
        const first = request.questions?.[0]
        get().showToast(`Agent asks: ${first?.header ?? "question"}`)
        systemNotify(
          `Agent asks a question`,
          {
            body: `${first?.header ?? first?.question ?? title} — ${title}`,
            tag: `kilo-question-${request.id ?? ""}`,
            onClick: () => window.location.assign(`/session/${request.sessionID}`),
          },
          loadNotifyPrefs(),
        )
        if (request.id && !get().questions.some((q) => q.id === request.id)) {
          set((s) => ({ questions: [...s.questions, request] }))
        }
        break
      }
      case "question.replied":
      case "question.v2.replied":
      case "question.rejected":
      case "question.v2.rejected": {
        const requestID = p.requestID as string | undefined
        if (requestID) set((s) => ({ questions: s.questions.filter((q) => q.id !== requestID) }))
        break
      }
      default:
        break
    }
  },
}))

/** Busy cycles that already qualified for a completion notification. */
const notifiedBusyCycles = new Set<string>()
let sseErrorCount = 0

/** Timestamp of the last SSE event that touched the open session. */
let lastOpenSessionEventAt = 0
let busyPollStarted = false

/**
 * Fallback while the open session is busy: if its events stop arriving (lost
 * upstream events with the SSE stream still heartbeating, or a reconnect in
 * flight), poll the transcript so the view catches up without a reload.
 * Skipped while the stream is delivering (avoids racing live deltas) and
 * while the tab is hidden.
 */
function startBusyMessagePoll(set: (partial: Partial<AppState>) => void, get: () => AppState): void {
  if (busyPollStarted) return
  busyPollStarted = true
  setInterval(() => {
    const { openSessionID, statuses } = get()
    if (!openSessionID || document.visibilityState !== "visible") return
    const type = statuses[openSessionID]?.type
    if (type !== "busy" && type !== "retry") return
    if (Date.now() - lastOpenSessionEventAt < 5_000) return
    void refreshOpenMessages(set, get, { silent: true })
  }, 10_000)
}

/** Refetch everything live after a (re)connect; includes the P0-3 projects refill. */
function gapFill(set: (partial: Partial<AppState>) => void, get: () => AppState): void {
  void get().refreshSessions()
  void get().refreshStatuses()
  void get().refreshPermissions()
  void get().refreshQuestions()
  void get().refreshAgentsAndProviders()
  if (get().openSessionID) void refreshOpenMessages(set, get)
  // P0-3: projects missed while kilo was warming up never load —refetch
  // them; refreshProjects applies the directory fallback and re-points the
  // event stream when the scope changes.
  if (get().projects.length === 0) {
    void get().refreshProjects()
  }
}

async function refreshOpenMessages(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  opts?: { silent?: boolean },
) {
  const { directory, openSessionID } = get()
  if (!openSessionID) return
  try {
    const messages = await api.get.messages(directory, openSessionID)
    if (get().openSessionID === openSessionID) set({ messages })
  } catch (err) {
    if (!opts?.silent && !(err instanceof ApiError && err.status === 401)) get().showToast(errText(err))
  }
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}
