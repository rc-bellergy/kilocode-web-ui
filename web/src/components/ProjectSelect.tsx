import { useStore } from "../store"

function projectLabel(p: { name?: string; worktree: string }): string {
  if (p.name) return p.name
  if (p.worktree === "/") return "global"
  const parts = p.worktree.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p.worktree
}

export default function ProjectSelect() {
  const projects = useStore((s) => s.projects)
  const directory = useStore((s) => s.directory)
  const setDirectory = useStore((s) => s.setDirectory)

  if (projects.length <= 1 && !directory) return null

  return (
    <select
      value={directory ?? ""}
      onChange={(e) => setDirectory(e.target.value)}
      title="Active project"
      className="max-w-64 truncate rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-500"
    >
      {projects.length === 0 && <option value="">{directory ?? "no project"}</option>}
      {projects.map((p) => (
        <option key={`${p.id}:${p.worktree}`} value={p.worktree} title={p.worktree}>
          {projectLabel(p)}
        </option>
      ))}
    </select>
  )
}
