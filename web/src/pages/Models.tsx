import { useState } from "react"
import { Link } from "react-router-dom"
import { useStore } from "../store"

function StarButton({ starred, onClick, title }: { starred: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={starred}
      className={`rounded-lg p-1.5 transition hover:bg-zinc-800 ${starred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-300"}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  )
}

export default function Models() {
  const directory = useStore((s) => s.directory)
  const providers = useStore((s) => s.providers)
  const favourites = useStore((s) => s.favourites)
  const toggleFavourite = useStore((s) => s.toggleFavourite)
  const [search, setSearch] = useState("")

  const connected = providers.filter((p) => Object.keys(p.models).length > 0)
  const isFavourite = (providerID: string, modelID: string) =>
    favourites.some((f) => f.providerID === providerID && f.modelID === modelID)
  const isAvailable = (providerID: string, modelID: string) => connected.some((p) => p.id === providerID && p.models[modelID])

  const sortedFavourites = [...favourites].sort((a, b) => a.addedAt - b.addedAt)
  const q = search.trim().toLowerCase()
  const filteredProviders = connected
    .map((p) => ({
      provider: p,
      models: Object.values(p.models)
        .filter(
          (m) =>
            !q ||
            m.name.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter(({ models }) => models.length > 0)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <Link
          to="/"
          className="mb-2 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-zinc-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5m7-7-7 7 7 7" />
          </svg>
          Back to sessions
        </Link>
        <h1 className="text-xl font-semibold">Models</h1>
        <p className="text-sm text-zinc-500">
          {directory ?? "no project"} — favourites apply everywhere, availability is per project
        </p>
      </div>

      <section aria-label="Favourites" className="mb-8">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Favourites</h2>
        {sortedFavourites.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            No favourites yet. Star models below to pin them to the composer.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800/70 rounded-xl border border-zinc-800 bg-zinc-900/60">
            {sortedFavourites.map((f) => {
              const available = isAvailable(f.providerID, f.modelID)
              const live = connected.find((p) => p.id === f.providerID)?.models[f.modelID]
              return (
                <li key={`${f.providerID}/${f.modelID}`} className="flex items-center gap-3 px-4 py-2.5">
                  <StarButton
                    starred
                    onClick={() => void toggleFavourite(f.providerID, f.modelID, f.name)}
                    title={`Unstar ${f.name ?? f.modelID}`}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="truncate text-sm text-zinc-100">{live?.name ?? f.name ?? f.modelID}</span>
                    <span className="ml-2 text-xs text-zinc-500">
                      {f.providerID}/{f.modelID}
                    </span>
                  </div>
                  {!available && (
                    <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-400">
                      not in this project
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-label="All models">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">All models</h2>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models or provider…"
            aria-label="Search models"
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-500"
          />
        </div>
        {filteredProviders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            {connected.length === 0 ? "No providers loaded for this project yet." : "No models match the search."}
          </p>
        ) : (
          <div className="space-y-4">
            {filteredProviders.map(({ provider, models }) => (
              <div key={provider.id}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {provider.name} <span className="font-normal text-zinc-600">{provider.id}</span>
                </h3>
                <ul className="divide-y divide-zinc-800/70 rounded-xl border border-zinc-800 bg-zinc-900/60">
                  {models.map((m) => {
                    const starred = isFavourite(provider.id, m.id)
                    return (
                      <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                        <StarButton
                          starred={starred}
                          onClick={() => void toggleFavourite(provider.id, m.id, m.name)}
                          title={starred ? `Unstar ${m.name}` : `Star ${m.name}`}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="truncate text-sm text-zinc-100">{m.name}</span>
                          <span className="ml-2 text-xs text-zinc-500">{m.id}</span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
