// Types mirroring the kilo serve REST/SSE payloads (v1 message shapes).

export interface Project {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  time: { created: number; updated: number; initialized?: number }
  sandboxes: string[]
}

export interface SessionTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface SessionInfo {
  id: string
  slug: string
  projectID: string
  workspaceID?: string
  directory: string
  path?: string
  parentID?: string
  title: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  version: string
  cost?: number
  tokens?: SessionTokens
  summary?: { additions: number; deletions: number; files: number }
  time: { created: number; updated: number; compacting?: number; archived?: number }
  metadata?: Record<string, unknown>
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "offline"; requestID: string; message: string }

export type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | { status: "running"; input: Record<string, unknown>; title?: string; time: { start: number } }
  | { status: "completed"; input: Record<string, unknown>; output: string; title: string; time: { start: number; end: number } }
  | { status: "error"; input: Record<string, unknown>; error: string; time: { start: number; end: number } }

export type Part =
  | { id: string; sessionID: string; messageID: string; type: "text"; text: string; time?: { start: number; end?: number } }
  | { id: string; sessionID: string; messageID: string; type: "reasoning"; text: string; time: { start: number; end?: number } }
  | { id: string; sessionID: string; messageID: string; type: "tool"; callID: string; tool: string; state: ToolState }
  | { id: string; sessionID: string; messageID: string; type: "file"; mime: string; filename?: string; url: string }
  | { id: string; sessionID: string; messageID: string; type: "step-start" }
  | { id: string; sessionID: string; messageID: string; type: "step-finish"; reason: string; cost: number; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
  | { id: string; sessionID: string; messageID: string; type: "agent"; name: string }
  | { id: string; sessionID: string; messageID: string; type: "subtask"; prompt: string; description: string; agent: string }
  | { id: string; sessionID: string; messageID: string; type: "retry"; attempt: number; error: { name?: string; message?: string }; time: { created: number } }
  | { id: string; sessionID: string; messageID: string; type: "snapshot"; snapshot: string }
  | { id: string; sessionID: string; messageID: string; type: "patch"; hash: string; files: string[] }
  | { id: string; sessionID: string; messageID: string; type: "compaction"; auto: boolean }

/** Any unrecognized part shape; rendered as raw JSON by the UI. */
export interface UnknownPart {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: unknown
}

export interface MessageError {
  name: string
  message?: string
}

export interface UserMessageInfo {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
}

export interface AssistantMessageInfo {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: MessageError
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  cost: number
  tokens: SessionTokens
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo

export interface Message {
  info: MessageInfo
  parts: Part[]
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export interface Agent {
  name: string
  displayName?: string
  description?: string
  mode: "subagent" | "primary" | "all"
  hidden?: boolean
  deprecated?: boolean
  model?: { modelID: string; providerID: string }
}

export interface ModelInfo {
  id: string
  providerID: string
  name: string
  status?: string
  limit?: { context?: number }
}

export interface ProviderInfo {
  id: string
  name: string
  source: string
  models: Record<string, ModelInfo>
}

export interface ProviderList {
  all: ProviderInfo[]
  default: Record<string, string>
  connected: string[]
}

export interface Health {
  kilo: { mode: "spawned" | "attached"; ready: boolean; url: string | null; error: string | null }
}

export interface KiloEvent {
  id: string
  type: string
  properties: Record<string, unknown>
}

export type PromptPayload = {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  parts: { type: "text"; text: string }[]
}
