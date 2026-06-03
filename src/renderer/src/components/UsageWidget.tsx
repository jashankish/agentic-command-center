import { useEffect, useState } from 'react'
import type { ClaudeUsage, UsageWindow } from '../../../shared/types'

/** Thresholds mirror the repo status colors: <70 green, 70–90 amber, >90 red. */
function tone(pct: number): '' | 'is-amber' | 'is-red' {
  if (pct > 90) return 'is-red'
  if (pct >= 70) return 'is-amber'
  return ''
}

function resetTitle(label: string, w: UsageWindow): string {
  if (!w.resetsAt) return `${label}: ${w.utilization}% used`
  const ms = new Date(w.resetsAt).getTime() - Date.now()
  if (Number.isNaN(ms)) return `${label}: ${w.utilization}% used`
  if (ms <= 0) return `${label}: ${w.utilization}% used · resetting`
  const hrs = Math.floor(ms / 3_600_000)
  const rel = hrs >= 24 ? `${Math.round(hrs / 24)}d` : hrs >= 1 ? `${hrs}h` : `${Math.round(ms / 60_000)}m`
  return `${label}: ${w.utilization}% used · resets in ${rel}`
}

/** Human "time until reset" for the note, e.g. "2h 15m", "45m", "1d 3h", or "now". */
function formatCountdown(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null
  const ms = new Date(resetsAt).getTime() - now
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return 'now'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d >= 1) return `${d}d ${h}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${m}m`
}

function Bar({ label, window: w }: { label: string; window: UsageWindow }): JSX.Element {
  return (
    <span className="usage-item" title={resetTitle(label, w)}>
      <span className="usage-label">
        {label} · {w.utilization}%
      </span>
      <span className="usage-bar">
        <span
          className={`usage-fill ${tone(w.utilization)}`}
          style={{ width: `${Math.min(100, w.utilization)}%` }}
        />
      </span>
    </span>
  )
}

export default function UsageWidget(): JSX.Element | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const load = (): void => {
      window.api.getUsage().then(setUsage)
    }
    load()
    // Poll gently — the usage endpoint rate-limits (429) frequent requests, and
    // the windows move slowly. The main process caches/backs off on top of this.
    const id = setInterval(load, 180000)
    return () => clearInterval(id)
  }, [])

  // Tick once a minute so the reset countdown stays accurate between polls
  // (no network — just re-renders the relative time).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  if (!usage) return null

  if (usage.error) {
    const msg =
      usage.error === 'stale'
        ? 'Claude session expired — open Claude Code to refresh'
        : /429|rate limit/i.test(usage.error)
          ? 'Claude usage rate-limited — retrying shortly'
          : 'Claude usage unavailable — open Claude Code'
    // The real (redacted) cause is in the tooltip for diagnosis.
    return (
      <div className="usage usage-muted" title={usage.error}>
        {msg}
      </div>
    )
  }

  const reset = formatCountdown(usage.session.resetsAt, now)

  return (
    <>
      <div className="usage">
        <Bar label="Session" window={usage.session} />
        <Bar label="Weekly" window={usage.weekly} />
        {usage.weeklyOpus && <Bar label="Opus" window={usage.weeklyOpus} />}
      </div>
      {reset && (
        <div className="usage-reset">
          {reset === 'now' ? 'Session quota resetting…' : `Session quota resets in ${reset}`}
        </div>
      )}
    </>
  )
}
