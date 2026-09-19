import { useStore } from "../store"

export default function ModeSelect({
  value,
  onChange,
}: {
  value: string | null
  onChange: (agent: string | null) => void
}) {
  const agents = useStore((s) => s.agents)
  const visible = agents.filter(
    (a) => !a.hidden && !a.deprecated && (a.mode === "primary" || a.mode === "all"),
  )
  const label = (a: { displayName?: string; name: string }) => a.displayName ?? a.name

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      title="Agent mode"
      className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500"
    >
      <option value="">default mode</option>
      {visible.map((a) => (
        <option key={a.name} value={a.name}>
          {label(a)}
        </option>
      ))}
    </select>
  )
}
