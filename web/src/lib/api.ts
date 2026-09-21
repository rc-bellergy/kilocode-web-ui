export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let sessionExpiredHandler: (() => void) | null = null
export function onSessionExpired(handler: () => void) {
  sessionExpiredHandler = handler
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { credentials: "same-origin", ...init })
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : "Network error")
  }
  if (res.status === 401 && sessionExpiredHandler) {
    sessionExpiredHandler()
    throw new ApiError(401, "Not authenticated")
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body?.error) detail = body.error
      else if (body?.message) detail = body.message
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail)
  }
  return res
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init)
  return (await res.json()) as T
}

function dir(directory: string | null | undefined): string {
  return directory ? `?directory=${encodeURIComponent(directory)}` : ""
}

export const api = {
  get: {
    health: () => json<import("./types").Health>("/api/health"),
    session: () => json<{ authenticated: boolean }>("/api/auth/session"),
    projects: () => json<import("./types").Project[]>("/api/kilo/project"),
    sessions: (d: string | null) => json<import("./types").SessionInfo[]>(`/api/kilo/session${dir(d)}`),
    statuses: (d: string | null) =>
      json<Record<string, import("./types").SessionStatus>>(`/api/kilo/session/status${dir(d)}`),
    messages: (d: string | null, sessionID: string) =>
      json<import("./types").Message[]>(`/api/kilo/session/${sessionID}/message${dir(d)}`),
    permissions: (d: string | null) => json<import("./types").PermissionRequest[]>(`/api/kilo/permission${dir(d)}`),
    questions: (d: string | null) => json<import("./types").QuestionRequest[]>(`/api/kilo/question${dir(d)}`),
    agents: (d: string | null) => json<import("./types").Agent[]>(`/api/kilo/agent${dir(d)}`),
    providers: (d: string | null) => json<import("./types").ProviderList>(`/api/kilo/provider${dir(d)}`),
    favourites: () => json<{ favourites: import("./types").Favourite[] }>("/api/favourites"),
    jevStatus: () => json<import("./types").JevStatus>("/api/jev/status"),
  },
  post: {
    login: (password: string) =>
      json<{ ok: boolean }>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    logout: () =>
      json<{ ok: boolean }>("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    createSession: (d: string | null) =>
      json<import("./types").SessionInfo>(`/api/kilo/session${dir(d)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    promptAsync: (d: string | null, sessionID: string, payload: import("./types").PromptPayload) =>
      request(`/api/kilo/session/${sessionID}/prompt_async${dir(d)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    abort: (d: string | null, sessionID: string) =>
      request(`/api/kilo/session/${sessionID}/abort${dir(d)}`, { method: "POST" }),
    permissionReply: (d: string | null, requestID: string, reply: "once" | "always" | "reject", message?: string) =>
      request(`/api/kilo/permission/${requestID}/reply${dir(d)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message !== undefined ? { reply, message } : { reply }),
      }),
    questionReply: (d: string | null, requestID: string, answers: string[][]) =>
      request(`/api/kilo/question/${requestID}/reply${dir(d)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      }),
    questionReject: (d: string | null, requestID: string) =>
      request(`/api/kilo/question/${requestID}/reject${dir(d)}`, { method: "POST" }),
    jevClassify: (payload: { requestID: string; sessionID?: string; command: string }) =>
      json<import("./types").JevVerdict>("/api/jev/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
  },
  put: {
    favourites: (list: import("./types").Favourite[]) =>
      json<{ favourites: import("./types").Favourite[] }>("/api/favourites", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favourites: list }),
      }),
  },
  del: {
    session: (d: string | null, sessionID: string) => request(`/api/kilo/session/${sessionID}${dir(d)}`, { method: "DELETE" }),
  },
}
