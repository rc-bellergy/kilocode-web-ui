import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"

export interface KiloStatus {
  mode: "spawned" | "attached"
  ready: boolean
  url: string | null
  error: string | null
}

export interface KiloManagerOptions {
  /** How long a spawned kilo CLI has to print its ready line. */
  startupTimeoutMs?: number
  /** Spawn budget: give up after this many consecutive start attempts. */
  maxStartAttempts?: number
  /** A ready (spawn) episode only counts as healthy (and resets the budget) after this long. */
  healthyResetMs?: number
  /** Attached mode: probe the target on this cadence while ready. */
  attachProbeMs?: number
  /** Timeout for a single attach/probe fetch. */
  attachTimeoutMs?: number
  /** Base delay for exponential restart/reattach backoff. */
  restartBaseDelayMs?: number
}

const READY_RE = /kilo server listening on (\S+)/
const DEFAULTS = {
  startupTimeoutMs: 10_000,
  maxStartAttempts: 5,
  healthyResetMs: 5 * 60_000,
  attachProbeMs: 5_000,
  attachTimeoutMs: 5_000,
  restartBaseDelayMs: 1_000,
}

export class KiloManager extends EventEmitter {
  private child: ChildProcess | null = null
  private password: string | null = null
  private username: string
  private url: string | null = null
  private mode: "spawned" | "attached"
  private ready = false
  private error: string | null = null
  private stderrTail: string[] = []
  private stopped = false
  private killChild: (() => void) | null = null

  /** Consecutive spawn attempts since the last healthy episode. */
  startAttempts = 0
  /** Timestamp of the current ready episode (null while not ready). */
  private readyAt: number | null = null
  private healthyTimer: NodeJS.Timeout | null = null
  private attachTimer: NodeJS.Timeout | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private attachCycleRunning = false

  private readonly opts: Required<KiloManagerOptions>

  constructor(options: KiloManagerOptions = {}) {
    super()
    this.opts = { ...DEFAULTS, ...options }
    this.mode = process.env.KILO_SERVER_URL ? "attached" : "spawned"
    this.username = process.env.KILO_SERVER_USERNAME || "kilo"
  }

  get status(): KiloStatus {
    return { mode: this.mode, ready: this.ready, url: this.url, error: this.error }
  }

  /** Basic auth header for kilo serve, or null when the target has no auth. */
  authHeader(): string | null {
    if (!this.password) return null
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`
  }

  baseUrl(): string | null {
    return this.url
  }

  async init(): Promise<void> {
    this.stopped = false
    if (this.mode === "attached") {
      this.startAttachCycle()
    } else {
      this.spawnServer()
    }
  }

  /**
   * Health-poll hook (P0-1): when attached and not ready, kick a fresh attach
   * cycle immediately instead of waiting for the next backoff tick.
   */
  retryNow(): void {
    if (this.stopped || this.mode !== "attached" || this.ready) return
    this.startAttachCycle()
  }

  private emitState() {
    this.emit("state", this.status)
  }

  // ------------------------------------------------------------- attach mode

  private attachTarget(): string {
    const raw = process.env.KILO_SERVER_URL!
    return raw.endsWith("/") ? raw.slice(0, -1) : raw
  }

  private startAttachCycle() {
    if (this.stopped || this.attachCycleRunning || this.ready) return
    this.attachCycleRunning = true
    void this.attachLoop()
  }

  private async attachLoop(): Promise<void> {
    let attempt = 0
    while (!this.stopped && !this.ready) {
      const ok = await this.attachOnce(attempt)
      if (ok) {
        this.attachCycleRunning = false
        this.startProbe()
        return
      }
      // attachOnce returns false only for retryable failures; 401 sets a
      // terminal error and breaks the loop via this.error !== retryable check.
      if (this.error?.includes("rejected credentials")) break
      attempt++
      const delay = Math.min(this.opts.restartBaseDelayMs * 2 ** Math.min(attempt - 1, 4), 15_000)
      await sleep(delay)
    }
    this.attachCycleRunning = false
  }

  /** One attach attempt. Returns true on success, false on retryable failure. */
  private async attachOnce(attempt: number): Promise<boolean> {
    const url = this.attachTarget()
    if (process.env.KILO_SERVER_PASSWORD) {
      this.password = process.env.KILO_SERVER_PASSWORD
    } else {
      this.password = null // target is unsecured
    }
    try {
      const res = await fetch(`${url}/project`, {
        headers: this.authHeader() ? { Authorization: this.authHeader()! } : {},
        signal: AbortSignal.timeout(this.opts.attachTimeoutMs),
      })
      if (res.status === 401) {
        this.setDown(`kilo server at ${url} rejected credentials (401)`)
        return false
      }
      if (!res.ok) throw new Error(`returned ${res.status}`)
      this.url = url
      this.markReady()
      this.emitState()
      return true
    } catch (err) {
      const prefix = attempt === 0 ? "Cannot attach to KILO_SERVER_URL" : "Re-attaching to KILO_SERVER_URL"
      this.setDown(`${prefix} (${url}): ${message(err)}`)
      return false
    }
  }

  /** While attached and ready, probe the target so a dead server is detected. */
  private startProbe() {
    this.stopProbe()
    const probe = async () => {
      if (this.stopped || !this.ready) return
      try {
        const res = await fetch(`${this.attachTarget()}/project`, {
          headers: this.authHeader() ? { Authorization: this.authHeader()! } : {},
          signal: AbortSignal.timeout(this.opts.attachTimeoutMs),
        })
        if (res.status === 401) {
          this.setDown(`kilo server at ${this.attachTarget()} rejected credentials (401)`)
          this.stopProbe()
          return
        }
        if (!res.ok) throw new Error(`returned ${res.status}`)
      } catch {
        this.setDown(`kilo server at ${this.attachTarget()} became unreachable; retrying…`)
        this.stopProbe()
        this.startAttachCycle()
      }
    }
    this.probeTimer = setInterval(() => void probe(), this.opts.attachProbeMs)
    this.probeTimer.unref()
  }

  private stopProbe() {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  // ------------------------------------------------------------- spawn mode

  private spawnServer() {
    if (this.stopped) return
    if (this.startAttempts >= this.opts.maxStartAttempts) {
      this.setDown(
        `kilo serve failed to start after ${this.opts.maxStartAttempts} attempts: ${
          this.stderrTail.join("\n").trim() || "unknown error"
        }`,
      )
      this.emitState()
      return
    }
    this.startAttempts++

    const cli = process.env.KILO_CLI_PATH || "kilo"
    this.password = crypto.randomBytes(32).toString("hex")
    this.stderrTail = []

    let settled = false
    let child: ChildProcess
    try {
      child = spawn(cli, ["serve", "--port=0"], {
        env: {
          ...process.env,
          KILO_SERVER_PASSWORD: this.password,
          KILO_PARENT_PID: String(process.pid),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      this.fail(`Failed to spawn kilo CLI (${cli}): ${message(err)}`)
      return
    }
    this.child = child

    const timeout = setTimeout(() => {
      if (!settled) {
        this.fail(`kilo serve did not become ready within ${this.opts.startupTimeoutMs / 1000}s`)
        this.kill()
      }
    }, this.opts.startupTimeoutMs)

    let stdoutBuf = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuf += chunk
      const m = READY_RE.exec(stdoutBuf)
      if (m && !settled) {
        settled = true
        clearTimeout(timeout)
        this.url = m[1]
        this.markReady()
        this.emitState()
      }
    })

    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 40) this.stderrTail.shift()
    })

    child.on("error", (err) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        this.fail(`kilo CLI error: ${message(err)}`)
      }
    })

    child.on("exit", (code, signal) => {
      clearTimeout(timeout)
      this.child = null
      if (this.stopped) return
      if (!settled) {
        settled = true
        // fail() emits state and schedules the restart (kill() below removed
        // the exit listeners, so this path runs exactly once per child).
        this.fail(`kilo serve exited before becoming ready (code=${code} signal=${signal})`)
      } else {
        this.setDown(`kilo serve exited unexpectedly (code=${code} signal=${signal}); restarting…`)
        this.emitState()
        this.scheduleRestart()
      }
    })

    this.killChild = () => {
      clearTimeout(timeout)
      this.kill()
    }
  }

  private kill() {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.removeAllListeners("exit")
    child.on("exit", () => {})
    try {
      child.kill("SIGTERM")
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }, 3_000).unref()
    } catch {
      /* already gone */
    }
  }

  // ------------------------------------------------------------- lifecycle

  /** Enter the ready state; the spawn budget resets only after a healthy episode. */
  private markReady() {
    this.ready = true
    this.error = null
    this.readyAt = Date.now()
    this.scheduleHealthyReset()
  }

  private scheduleHealthyReset() {
    if (this.healthyTimer) clearTimeout(this.healthyTimer)
    const episodeAt = this.readyAt
    this.healthyTimer = setTimeout(() => {
      // Same ready episode that survived >= healthyResetMs: reset the budget (P0-2).
      if (this.readyAt === episodeAt && this.ready) this.startAttempts = 0
    }, this.opts.healthyResetMs)
    this.healthyTimer.unref()
  }

  private setDown(error: string) {
    this.ready = false
    this.readyAt = null
    if (this.healthyTimer) clearTimeout(this.healthyTimer)
    this.healthyTimer = null
    this.error = error
  }

  private fail(msg: string) {
    this.setDown(msg)
    this.emitState()
    this.scheduleRestart()
  }

  private scheduleRestart() {
    if (this.stopped) return
    const delay = Math.min(this.opts.restartBaseDelayMs * 2 ** Math.min(this.startAttempts - 1, 4), 15_000)
    this.attachTimer = setTimeout(() => this.spawnServer(), delay)
    this.attachTimer.unref()
  }

  stop() {
    this.stopped = true
    this.stopProbe()
    if (this.healthyTimer) clearTimeout(this.healthyTimer)
    if (this.attachTimer) clearTimeout(this.attachTimer)
    this.killChild?.()
    this.setDown("stopped")
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const kilo = new KiloManager()
