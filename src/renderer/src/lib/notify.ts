import type {
  AgentSessionState,
  ClaudeUsage,
  PanelPrefs,
  RepoInsights,
  TerminalsSnapshot
} from '../../../shared/types'

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

// ── Agent session notifications (terminals panel) ──────────────────────────
// Same transition discipline as above: prime on the first snapshot, notify on
// permission-prompt *transitions*, and nudge once per waiting spell when a
// session has sat blocked for a while.

let agentsPrimed = false
const lastAgentState = new Map<string, string>()
const escalatedSpells = new Set<string>()

const ESCALATE_AFTER_MS = 5 * 60_000
// Sessions idle longer than this predate the user's attention span on
// purpose (e.g. left open overnight) — nagging about them helps no one.
const ESCALATE_CUTOFF_MS = 60 * 60_000

const sessionKey = (s: AgentSessionState): string => s.sessionId ?? `pid-${s.pid}`

const repoLabel = (s: AgentSessionState): string => {
  const p = s.repoPath ?? s.cwd
  return p ? p.split('/').pop() || p : 'a session'
}

export function checkAgentNotifications(snap: TerminalsSnapshot, prefs: PanelPrefs): void {
  const sessions: AgentSessionState[] = [
    ...snap.entries.flatMap((e) => (e.agent ? [e.agent] : [])),
    ...snap.unbound
  ]
  const seen = new Set<string>()
  for (const s of sessions) {
    const key = sessionKey(s)
    seen.add(key)

    const prev = lastAgentState.get(key)
    if (agentsPrimed && prefs.notifyPermission && s.state === 'permission' && prev !== 'permission') {
      const what = s.detail?.summary
        ? `${s.detail.tool ?? 'a tool'} — ${s.detail.summary}`
        : (s.detail?.tool ?? 'a tool')
      fire('Claude needs permission', `${repoLabel(s)}: wants to use ${what}`)
    }
    if (agentsPrimed && prefs.notifyInput && s.state === 'input' && prev && prev !== 'input') {
      fire('Claude finished — your turn', `${repoLabel(s)} is waiting for your reply`)
    }
    lastAgentState.set(key, s.state)

    if (
      agentsPrimed &&
      prefs.notifyStale &&
      (s.state === 'permission' || s.state === 'input') &&
      s.since
    ) {
      const waited = Date.now() - new Date(s.since).getTime()
      const spell = `${key}:${s.state}:${s.since}`
      if (waited > ESCALATE_AFTER_MS && waited < ESCALATE_CUTOFF_MS && !escalatedSpells.has(spell)) {
        escalatedSpells.add(spell)
        fire(
          s.state === 'permission'
            ? 'Claude is still waiting for permission'
            : 'Claude finished and is waiting',
          `${repoLabel(s)} has been waiting ${Math.round(waited / 60_000)}m`
        )
      }
    }
  }
  for (const k of [...lastAgentState.keys()]) if (!seen.has(k)) lastAgentState.delete(k)
  if (escalatedSpells.size > 300) escalatedSpells.clear()
  agentsPrimed = true
}
