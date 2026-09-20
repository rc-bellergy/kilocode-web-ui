import { type ChildProcess, spawn } from "node:child_process"
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export const MAIN_PORT = 3210
export const MAIN_BASE = `http://127.0.0.1:${MAIN_PORT}`
export const REAL_PASSWORD = "kilo-real"
export const ROOT_DIR = path.resolve(import.meta.dirname, "..")
/** kilocode-web is a registered kilo project; sessions created here are
 *  cleaned up right after each test. */
export const TEST_DIRECTORY = ROOT_DIR

const PID_DIR = path.join(os.tmpdir(), "kilo-e2e-real")

let mainBackend: ChildProcess | null = null

export interface RealBackend {
  child: ChildProcess
  port: number
  base: string
  stop: () => Promise<void>
}

export function waitPort(base: string, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) })
        if (res.ok) return resolve()
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${base}`))
      setTimeout(tick, 250)
    }
    void tick()
  })
}

export function waitPortStopped(base: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })
      } catch {
        return resolve()
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`${base} still responding`))
      setTimeout(tick, 200)
    }
    void tick()
  })
}

export async function waitKiloReady(base: string, timeoutMs = 90_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { kilo: { ready: boolean } }
      if (health.kilo?.ready) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`kilo never became ready behind ${base}`)
}

export function startBackend(opts: {
  port: number
  attach?: string
  cookieSecure?: boolean
  env?: Record<string, string>
}): RealBackend {
  fs.mkdirSync(PID_DIR, { recursive: true })
  // kilo-web's own state (favourites) stays out of the repo in real e2e too.
  fs.rmSync(path.join(PID_DIR, "data", "favourites.json"), { force: true })
  const env: Record<string, string> = {
    ...process.env,
    PORT: String(opts.port),
    HOST: "127.0.0.1",
    KILO_WEB_PASSWORD: REAL_PASSWORD,
    KILO_WEB_DATA_DIR: path.join(PID_DIR, "data"),
    ...(opts.attach ? { KILO_SERVER_URL: opts.attach } : {}),
    ...(opts.cookieSecure ? { COOKIE_SECURE: "1" } : {}),
    ...opts.env,
  }
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT_DIR, "server/src/index.ts")], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  })
  // Tee backend output to a file for debugging recovery behaviour.
  fs.mkdirSync(PID_DIR, { recursive: true })
  const log = fs.createWriteStream(path.join(PID_DIR, `backend-${opts.port}.log`), { flags: "w" })
  child.stdout!.on("data", (c: Buffer) => log.write(c))
  child.stderr!.on("data", (c: Buffer) => log.write(c))
  const backend: RealBackend = {
    child,
    port: opts.port,
    base: `http://127.0.0.1:${opts.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already gone */
        }
        const died = () => resolve()
        child.once("exit", died)
        setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* ignore */
          }
          resolve()
        }, 5_000).unref()
      }),
  }
  return backend
}

/** Start the main spawn-mode backend used by most tests. */
export async function startMainBackend(): Promise<void> {
  const backend = startBackend({ port: MAIN_PORT })
  mainBackend = backend.child
  fs.writeFileSync(path.join(PID_DIR, "backend.pid"), String(backend.child.pid))
  await waitPort(MAIN_BASE)
  await waitKiloReady(MAIN_BASE)
}

export async function stopMainBackend(): Promise<void> {
  const pid = Number(fs.readFileSync(path.join(PID_DIR, "backend.pid"), "utf8"))
  if (pid) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  mainBackend?.kill("SIGKILL")
  fs.rmSync(path.join(PID_DIR, "backend.pid"), { force: true })
}

/** Direct `kilo serve` child of a backend (spawn mode). */
export function kiloChildPid(backendPid: number): number {
  const out = execSync(`pgrep -P ${backendPid} || true`).toString().trim()
  if (!out) throw new Error(`no child process under backend pid ${backendPid}`)
  // The kilo serve process is the (only) direct child.
  const pids = out.split("\n").map(Number)
  for (const pid of pids) {
    try {
      const cmd = execSync(`ps -o command= -p ${pid}`).toString()
      if (cmd.includes("kilo")) return pid
    } catch {
      /* gone */
    }
  }
  throw new Error(`no kilo child under backend pid ${backendPid} (children: ${out})`)
}

/** SIGKILL the backend's kilo child, simulating a crash. */
export function crashKilo(backendPid: number): number {
  const pid = kiloChildPid(backendPid)
  console.log(`[crashKilo] backend=${backendPid} killing kilo child pid=${pid}`)
  process.kill(pid, "SIGKILL")
  return pid
}

/** Start a standalone real `kilo serve` and wait for its ready line. */
export function startKiloServe(port: number): { child: ChildProcess; base: string; stop: () => Promise<void>; output: () => string } {
  const child = spawn("kilo", ["serve", `--port=${port}`], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  })
  let combined = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (c: string) => (combined += c))
  child.stdout?.setEncoding("utf8")
  child.stdout?.on("data", (c: string) => (combined += c))
  return {
    child,
    base: `http://127.0.0.1:${port}`,
    output: () => combined,
    stop: () =>
      new Promise<void>((resolve) => {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already gone */
        }
        child.once("exit", () => resolve())
        setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* ignore */
          }
          resolve()
        }, 5_000).unref()
      }),
  }
}

export async function waitKiloServeDirect(base: string, timeoutMs = 60_000, diagnostics?: () => string): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${base}/project`, { signal: AbortSignal.timeout(1_000) })
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`kilo serve at ${base} never became ready${diagnostics ? `; output: ${diagnostics().slice(-2000)}` : ""}`)
}

/** Poll the backend's own health until its kilo is down (deterministic,
 *  unlike the UI banner which depends on the 5s poll). */
export async function waitBackendKiloDown(base: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now()
  let polls = 0
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) })
      const health = (await res.json()) as { kilo: { ready: boolean } }
      polls++
      if (polls <= 5 || health.kilo?.ready === false) {
        console.log(`[down-poll ${Date.now()}] t=${Date.now() - t0}ms ready=${health.kilo?.ready}`)
      }
      if (health.kilo?.ready === false) return
    } catch (err) {
      console.log(`[down-poll ${Date.now()}] t=${Date.now() - t0}ms fetch-error ${err instanceof Error ? err.message : err}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(`[down-poll] gave up after ${Date.now() - t0}ms, polls=${polls}`)
  throw new Error(`backend kilo at ${base} never went down`)
}

export async function waitBackendKiloUp(base: string, timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { kilo: { ready: boolean } }
      if (health.kilo?.ready === true) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`backend kilo at ${base} never came back`)
}

export async function loginReal(page: Page, base = MAIN_BASE, password = REAL_PASSWORD): Promise<void> {
  await page.goto(`${base}/`)
  await page.fill("#password", password)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expectLoaded(page, base)
}

async function expectLoaded(page: Page, base: string) {
  await page.waitForURL(new RegExp(`${base.replace(/\//g, "\\/")}/$`), { timeout: 15_000 })
}

/**
 * Point the page's project selector at the kilocode-web worktree (keeps test
 * sessions inside this app's own project). Falls back to the first project
 * when kilocode-web is not registered; the returned directory must then be
 * passed to the create/delete helpers.
 */
export async function selectTestProject(page: Page): Promise<string> {
  const select = page.getByTitle("Active project")
  await expect(select).toBeVisible({ timeout: 30_000 })
  const has = await select.locator(`option[value="${TEST_DIRECTORY}"]`).count()
  if (has > 0) {
    await select.selectOption(TEST_DIRECTORY)
    return TEST_DIRECTORY
  }
  const fallback = (await select.locator("option").first().getAttribute("value")) ?? ""
  if (!fallback) throw new Error("project selector has no options")
  await select.selectOption(fallback)
  return fallback
}

/** DELETE a session through the backend REST API from inside the page. */
export async function deleteSessionViaApi(page: Page, sessionID: string, directory = TEST_DIRECTORY): Promise<void> {
  await page
    .evaluate(
      async ({ id, dir }) => {
        await fetch(`/api/kilo/session/${id}?directory=${encodeURIComponent(dir)}`, {
          method: "DELETE",
          credentials: "same-origin",
        }).catch(() => {})
      },
      { id: sessionID, dir: directory },
    )
    .catch(() => {})
}

/** Create a session through the backend REST API from inside the page. */
export async function createSessionViaApi(page: Page, directory = TEST_DIRECTORY): Promise<string | null> {
  return page.evaluate(async (dir) => {
    try {
      const res = await fetch(`/api/kilo/session?directory=${encodeURIComponent(dir)}`, {
        method: "POST",
        credentials: "same-origin",
      })
      if (!res.ok) return null
      const info = (await res.json()) as { id: string }
      return info.id
    } catch {
      return null
    }
  }, directory)
}
