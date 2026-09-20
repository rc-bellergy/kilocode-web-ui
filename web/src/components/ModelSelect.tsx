import { useNavigate } from "react-router-dom"
import { useStore } from "../store"

/** Sentinel option value; real model values always contain a "/". */
const MANAGE_VALUE = "__manage__"

export default function ModelSelect({
  value,
  onChange,
}: {
  value: { providerID: string; modelID: string } | null
  onChange: (model: { providerID: string; modelID: string } | null) => void
}) {
  const providers = useStore((s) => s.providers)
  const favourites = useStore((s) => s.favourites)
  const navigate = useNavigate()

  const connected = providers.filter((p) => Object.keys(p.models).length > 0)
  const current = value ? `${value.providerID}/${encodeURIComponent(value.modelID)}` : ""

  // Only favourites available in the current directory's providers are listed;
  // the label prefers the live model name over the cached favourite name.
  const options = favourites
    .map((f) => {
      const provider = connected.find((p) => p.id === f.providerID)
      const model = provider?.models[f.modelID]
      if (!provider || !model) return null
      return { value: `${provider.id}/${encodeURIComponent(model.id)}`, label: `${provider.name} · ${model.name}` }
    })
    .filter((o): o is { value: string; label: string } => o !== null)

  // A stored (localStorage) pick that is not a favourite keeps its old
  // send-anyway semantics: render it as an extra option instead of silently
  // showing a wrong value.
  const currentModel = value ? connected.find((p) => p.id === value.providerID)?.models[value.modelID] : undefined
  const showCurrent = Boolean(current) && !options.some((o) => o.value === current)

  return (
    <select
      value={current}
      onChange={(e) => {
        const v = e.target.value
        if (!v) {
          onChange(null)
          return
        }
        if (v === MANAGE_VALUE) {
          navigate("/models")
          return
        }
        const slash = v.indexOf("/")
        onChange({ providerID: v.slice(0, slash), modelID: decodeURIComponent(v.slice(slash + 1)) })
      }}
      title="Model"
      className="max-w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500"
    >
      <option value="">default model</option>
      {showCurrent && <option value={current}>current · {currentModel?.name ?? value?.modelID}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      <option disabled>────────</option>
      <option value={MANAGE_VALUE}>Manage models…</option>
    </select>
  )
}
