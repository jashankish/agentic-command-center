import { useState } from 'react'

interface Props {
  title: string
  label: string
  initial?: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** A tiny single-line text prompt (sandboxed renderer has no window.prompt). */
export default function PromptDialog({
  title,
  label,
  initial = '',
  placeholder,
  onSubmit,
  onCancel
}: Props): JSX.Element {
  const [value, setValue] = useState(initial)

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="dialog-sub">{label}</p>
        <input
          className="prompt-input"
          value={value}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value.trim())
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSubmit(value.trim())}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
