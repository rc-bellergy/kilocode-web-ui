import { FormEvent, useState } from "react"
import { api, ApiError } from "../lib/api"

export default function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.post.login(password)
      onLoggedIn()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid password" : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-indigo-500 text-lg font-bold text-zinc-950">
            K
          </span>
          <div>
            <h1 className="text-lg font-semibold">Kilo Code</h1>
            <p className="text-sm text-zinc-400">Sign in to continue</p>
          </div>
        </div>
        <label className="mb-1.5 block text-sm text-zinc-300" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={!password || busy}
          className="w-full rounded-lg bg-sky-500 py-2 font-medium text-zinc-950 transition hover:bg-sky-400 disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  )
}
