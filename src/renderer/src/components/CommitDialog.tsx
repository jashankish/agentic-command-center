import { useState } from 'react'

interface Props {
  repoName: string
  defaultMessage: string
  error?: string
  busy: boolean
  onSubmit: (message: string) => void
  onCancel: () => void
}

export default function CommitDialog({
  repoName,
  defaultMessage,
  error,
  busy,
  onSubmit,
  onCancel
}: Props): JSX.Element {
  const [message, setMessage] = useState(defaultMessage)

  return (
    <div className="overlay" onClick={() => !busy && onCancel()}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Sync “{repoName}”</h2>
        <p className="dialog-sub">Stage all changes, commit, then push the current branch.</p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="Commit message"
          autoFocus
          disabled={busy}
        />
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !message.trim()}
            onClick={() => onSubmit(message.trim())}
          >
            {busy ? 'Syncing…' : 'Commit & Push'}
          </button>
        </div>
      </div>
    </div>
  )
}
