import { useEffect, useState } from 'react'
import type { Standup } from '../../../shared/types'
import { fmtCost } from '../lib/format'

type Range = 'today' | '24h' | '7d'

const SINCE: Record<Range, () => string> = {
  today: () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  },
  '24h': () => new Date(Date.now() - 24 * 3600_000).toISOString(),
  '7d': () => new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
}

interface Props {
  claudeToday: number
  claudeWeek: number
  onCancel: () => void
}

/** A standup digest: the user's commits across all repos over a chosen window. */
export default function StandupDialog({ claudeToday, claudeWeek, onCancel }: Props): JSX.Element {
  const [range, setRange] = useState<Range>('today')
  const [data, setData] = useState<Standup | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      const repos = await window.api.listRepos()
      const result = await window.api.getStandup(repos, SINCE[range]())
      if (alive) {
        setData(result)
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [range])

  const claudeCost = range === '7d' ? claudeWeek : claudeToday

  const copy = (): void => {
    if (!data) return
    const lines = data.repos.flatMap((r) => [
      `${r.name}:`,
      ...r.commits.map((c) => `  - ${c.message}`)
    ])
    void navigator.clipboard?.writeText(lines.join('\n'))
  }

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="standup-head">
          <h2>Standup</h2>
          <div className="seg">
            {(['today', '24h', '7d'] as Range[]).map((r) => (
              <button
                key={r}
                className={range === r ? 'active' : ''}
                onClick={() => setRange(r)}
              >
                {r === 'today' ? 'Today' : r === '24h' ? '24h' : '7 days'}
              </button>
            ))}
          </div>
        </div>

        <p className="dialog-sub">
          {loading
            ? 'Gathering commits…'
            : `${data?.totalCommits ?? 0} commit(s) across ${data?.repos.length ?? 0} repo(s) · ~${fmtCost(claudeCost)} Claude`}
        </p>

        <div className="standup-body">
          {data && data.repos.length === 0 && !loading && (
            <div className="standup-empty">No commits in this window.</div>
          )}
          {data?.repos.map((r) => (
            <div key={r.path} className="standup-repo">
              <div className="standup-repo-name">{r.name}</div>
              <ul>
                {r.commits.map((c) => (
                  <li key={c.hash} title={c.relative}>
                    <code>{c.hash}</code> {c.message}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>Close</button>
          <button className="primary" disabled={!data || data.totalCommits === 0} onClick={copy}>
            Copy
          </button>
        </div>
      </div>
    </div>
  )
}
