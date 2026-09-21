// Browser notifications + title badge + optional beep (feature F).
// In-tab only by design: works while the tab is open (including background
// tabs); no service worker / push for closed tabs.

export interface NotifyPrefs {
  enabled: boolean
}

const NOTIFY_KEY = "kilo-web.notify"

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(NOTIFY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NotifyPrefs>
      return { enabled: Boolean(parsed.enabled) }
    }
  } catch {
    /* storage unavailable */
  }
  return { enabled: false }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable */
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported"
}

/** Must be called from a user gesture (bell button click). */
export async function ensurePermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported"
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission()
    } catch {
      /* ignored */
    }
  }
  return Notification.permission
}

export interface NotifyOptions {
  body?: string
  tag?: string
  onClick?: () => void
}

/**
 * Fire a system notification. The OS notification only fires when the tab is
 * hidden (foreground uses toast/badge to avoid double-buzzing) and permission
 * is granted; the beep is independent of both — it plays whenever enabled.
 */
export function systemNotify(title: string, opts: NotifyOptions = {}, prefs: NotifyPrefs): void {
  if (!prefs.enabled) return
  beep()
  if (!notificationsSupported() || Notification.permission !== "granted") return
  if (!document.hidden) return
  try {
    const n = new Notification(title, { body: opts.body, tag: opts.tag })
    n.onclick = () => {
      window.focus()
      opts.onClick?.()
      n.close()
    }
  } catch {
    /* some platforms throw on ctor without SW; badge still works */
  }
}

let audioCtx: AudioContext | null = null

/**
 * Create/resume the AudioContext inside a user gesture (bell toggle click) so
 * autoplay policy lets later beeps play, including in background tabs.
 */
export function primeAudio(): void {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {})
  } catch {
    /* audio unsupported */
  }
}

/** Short two-tone beep via WebAudio; no asset files needed. */
export function beep(): void {
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {})
    const t = audioCtx.currentTime
    for (const [freq, start] of [
      [880, 0],
      [1320, 0.12],
    ] as const) {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.frequency.value = freq
      osc.type = "sine"
      gain.gain.setValueAtTime(0.0001, t + start)
      gain.gain.exponentialRampToValueAtTime(0.1, t + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.15)
      osc.connect(gain).connect(audioCtx.destination)
      osc.start(t + start)
      osc.stop(t + start + 0.16)
    }
  } catch {
    /* autoplay blocked or unavailable */
  }
}

// ---------------------------------------------------------------- title badge

let baseTitle: string | null = null

/** Show "(n) <base title>" while n > 0; restore the original title at 0. */
export function updateTitleBadge(count: number): void {
  if (typeof document === "undefined") return
  baseTitle ??= document.title
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle
}
