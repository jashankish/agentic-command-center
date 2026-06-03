import type { RepoStatus } from '../../../shared/types'
import { deriveState } from '../lib/status'

interface Props {
  status: RepoStatus
  index: number
  busy: boolean
  onSync: () => void
  onRemove: () => void
}

export default function RepoBox({ status, index, busy, onSync, onRemove }: Props): JSX.Element {
  const state = deriveState(status)
  const handleClick = (): void => {
    if (!busy && state.canSync) onSync()
  }

  return (
    <div
      className={`tile tile-${state.color} ${state.canSync ? 'clickable' : ''} ${busy ? 'busy' : ''}`}
      title={state.detail}
      onClick={handleClick}
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
    >
      <span className="tile-glow" />
      <button
        className="tile-remove"
        title="Remove from list"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      <span className="tile-dot" />
      <div className="tile-name" title={status.path}>
        {status.name}
      </div>
      <div className="tile-branch">{status.branch ?? '—'}</div>
      <div className="tile-badge">{busy ? 'Working…' : state.badge}</div>
    </div>
  )
}
