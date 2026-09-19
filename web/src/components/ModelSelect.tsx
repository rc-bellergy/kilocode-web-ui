import { useStore } from "../store"

export default function ModelSelect({
  value,
  onChange,
}: {
  value: { providerID: string; modelID: string } | null
  onChange: (model: { providerID: string; modelID: string } | null) => void
}) {
  const providers = useStore((s) => s.providers)
  const connected = providers.filter((p) => Object.keys(p.models).length > 0)
  const current = value ? `${value.providerID}/${encodeURIComponent(value.modelID)}` : ""

  return (
    <select
      value={current}
      onChange={(e) => {
        const v = e.target.value
        if (!v) {
          onChange(null)
          return
        }
        const [providerID, modelID] = v.split("/")
        onChange({ providerID, modelID: decodeURIComponent(modelID) })
      }}
      title="Model"
      className="max-w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500"
    >
      <option value="">default model</option>
      {connected.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {Object.values(p.models)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => (
              <option key={m.id} value={`${p.id}/${encodeURIComponent(m.id)}`}>
                {m.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}
