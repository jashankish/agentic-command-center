import type { RepoInsights, ClaudeUsage } from '../../../shared/types'

// Track previous state so we only notify on *transitions*, not every poll. The
// first run primes the baseline without firing (avoids a burst on launch).
let lastCiFail = new Set<string>()
let lastUsageHigh = false
let lastReviews = 0
let primed = false

export function requestNotifyPermission(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  } catch {
    // not supported — ignore
  }
}

function fire(title: string, body: string): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      // eslint-disable-next-line no-new
      new Notification(title, { body, silent: false })
    }
  } catch {
    // ignore
  }
}

interface Snapshot {
  insights: Record<string, RepoInsights>
  nameOf: (path: string) => string
  usage: ClaudeUsage | null
}

/** Compare the latest snapshot to the previous one and surface notable changes. */
export function checkNotifications({ insights, nameOf, usage }: Snapshot): void {
  const values = Object.values(insights)

  const fails = new Set(values.filter((i) => i.ci === 'fail').map((i) => i.path))
  if (primed) {
    for (const p of fails) {
      if (!lastCiFail.has(p)) fire('CI failing', `${nameOf(p)} — latest run failed`)
    }
  }
  lastCiFail = fails

  const reviews = values.reduce((n, i) => n + i.reviewRequests, 0)
  if (primed && reviews > lastReviews) {
    fire('Review requested', `${reviews} open PR${reviews === 1 ? '' : 's'} awaiting your review`)
  }
  lastReviews = reviews

  const high =
    !!usage &&
    !usage.error &&
    (usage.session.utilization >= 90 || usage.weekly.utilization >= 90)
  if (primed && high && !lastUsageHigh) {
    fire('Claude usage high', 'You are past 90% of a usage window')
  }
  lastUsageHigh = high

  primed = true
}
