import { useState } from 'react'

interface Props {
  found: string[]
  existing: Set<string>
  onAdd: (paths: string[]) => void
  onCancel: () => void
}

/** Lists repos found by a folder scan with checkboxes; adds the selected ones. */
export default function DiscoverDialog({ found, existing, onAdd, onCancel }: Props): JSX.Element {
  const fresh = found.filter((p) => !existing.has(p))
  const [selected, setSelected] = useState<Set<string>>(new Set(fresh))

  const toggle = (p: string): void =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Repositories found</h2>
        <p className="dialog-sub">
          {found.length === 0
            ? 'No git repositories found in that folder.'
            : `${fresh.length} new, ${found.length - fresh.length} already imported.`}
        </p>

        {fresh.length > 0 && (
          <ul className="discover-list">
            {fresh.map((p) => (
              <li key={p}>
                <label>
                  <input type="checkbox" checked={selected.has(p)} onChange={() => toggle(p)} />
                  <span className="discover-name">{p.split('/').pop()}</span>
                  <span className="discover-path">{p}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            disabled={selected.size === 0}
            onClick={() => onAdd([...selected])}
          >
            Add {selected.size > 0 ? selected.size : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
