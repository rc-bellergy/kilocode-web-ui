import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const MOCK_KILO_PORT = 4180
export const MOCK_CONTROL_PORT = 4181
// Overridable so the suite never has to fight a live dev server for 3100.
export const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 3100)
export const MOCK_KILO_URL = `http://127.0.0.1:${MOCK_KILO_PORT}`
export const CONTROL_URL = `http://127.0.0.1:${MOCK_CONTROL_PORT}`
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

const PID_DIR = path.join(os.tmpdir(), "kilo-e2e")
const MOCK_PID_FILE = path.join(PID_DIR, "mock.pid")
const BACKEND_PID_FILE = path.join(PID_DIR, "backend.pid")
const ROOT = path.resolve(import.meta.dirname, "..")

let localMock: ChildProcess | null = null

async function waitPortReady(url: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (res.status < 500) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function waitPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    } catch {
      return // connection refused → free
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`timeout waiting for port ${port} to become free`)
}

export async function isMockUp(): Promise<boolean> {
  try {
    const res = await fetch(`${MOCK_KILO_URL}/project`, { signal: AbortSignal.timeout(1_000) })
    return res.ok
  } catch {
    return false
  }
}

export async function startMock(): Promise<void> {
  if (await isMockUp()) return
  fs.mkdirSync(PID_DIR, { recursive: true })
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "server/test/mock-kilo-server.ts"), "--kilo-port", String(MOCK_KILO_PORT), "--control-port", String(MOCK_CONTROL_PORT)],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env },
  )
  localMock = child
  child.stdout!.on("data", () => {})
  child.stderr!.on("data", () => {})
  fs.writeFileSync(MOCK_PID_FILE, String(child.pid))
  await waitPortReady(`${MOCK_KILO_URL}/project`)
  await waitPortReady(`${CONTROL_URL}/__control/state`)
}

export async function killMock(): Promise<void> {
  try {
    await fetch(`${CONTROL_URL}/__control/exit`, { method: "POST" })
  } catch {
    /* already down */
  }
  await waitPortFree(MOCK_KILO_PORT)
  try {
    fs.rmSync(MOCK_PID_FILE, { force: true })
  } catch {
    /* ignore */
  }
  localMock = null
}

export async function control<T = unknown>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CONTROL_URL}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

export function mockState(): Promise<{
  sessions: { id: string; directory: string }[]
  statuses: Record<string, { type: string }>
  permissions: { id: string; sessionID: string; permission: string }[]
  questions: { id: string; sessionID: string }[]
  replies: { requestID: string; reply: string; message?: string }[]
  questionReplies: { requestID: string; answers: string[][] | null; rejected: boolean }[]
  aborts: string[]
  prompts: { sessionID: string; body: { agent?: string; model?: unknown; parts: { type: string; text?: string }[] } }[]
  lastEventIDs: (string | undefined)[]
  hung: string[]
}> {
  return control("/__control/state")
}

export async function startBackend(): Promise<void> {
  fs.mkdirSync(PID_DIR, { recursive: true })
  // kilo-web's own state (favourites) lives outside the repo in tests.
  const dataDir = path.join(PID_DIR, "data")
  fs.rmSync(path.join(dataDir, "favourites.json"), { force: true })
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "server/src/index.ts")],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(BACKEND_PORT),
        HOST: "127.0.0.1",
        KILO_WEB_PASSWORD: "kilo",
        KILO_SERVER_URL: MOCK_KILO_URL,
        KILO_WEB_DATA_DIR: dataDir,
        // server/src/env.ts loads the repo-root .env; neutralize the keys that
        // would otherwise make tests depend on this machine's private config
        // (e.g. COOKIE_SECURE=1 or an ALLOWED_IPS without loopback breaks e2e).
        ALLOWED_IPS: "",
        COOKIE_SECURE: "0",
        KILO_SERVER_PASSWORD: "",
        // Deterministic Jev scores for the auto-approve specs; the feature is
        // default-off so all other suites are unaffected.
        JEV_MOCK: "1",
        REQUESTY_JEV_KEY: "",
      },
    },
  )
  child.stdout!.on("data", () => {})
  child.stderr!.on("data", () => {})
  fs.writeFileSync(BACKEND_PID_FILE, String(child.pid))
  await waitPortReady(`${BACKEND_URL}/api/health`)
}

export async function stopBackend(): Promise<void> {
  const pid = Number(fs.readFileSync(BACKEND_PID_FILE, "utf8"))
  if (pid) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  await waitPortFree(BACKEND_PORT)
  fs.rmSync(BACKEND_PID_FILE, { force: true })
}
