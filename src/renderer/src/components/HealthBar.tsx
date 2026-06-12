import type {
  RepoStatus,
  RepoInsights,
  ClaudeActivity,
  DevServer,
  SystemStats,
  CalendarData
} from '../../../shared/types'
import { deriveState } from '../lib/status'
import { fmtCost } from '../lib/format'

interface Props {
  statuses: RepoStatus[]
  insights: Record<string, RepoInsights>
  claude: ClaudeActivity | null
  devServers: DevServer[]
  system: SystemStats | null
  calendar: CalendarData | null
  /** Claude sessions currently blocked on the user (terminals panel). */
  agentsWaiting?: number
}

function nextEvent(calendar: CalendarData | null): string | null {
  if (!calendar || !calendar.available) return null
  const now = Date.now()
  const upcoming = calendar.events
    .filter((e) => !e.allDay && new Date(e.start).getTime() >= now)
    .sort((a, b) => a.start.localeCompare(b.start))[0]
  if (!upcoming) return null
  const t = new Date(upcoming.start)
  const hh = t.getHours() % 12 || 12
  const mm = String(t.getMinutes()).padStart(2, '0')
  const ap = t.getHours() < 12 ? 'am' : 'pm'
  const title = upcoming.title.length > 22 ? upcoming.title.slice(0, 21) + '…' : upcoming.title
  return `${title} · ${hh}:${mm}${ap}`
}

interface Chip {
  key: string
  tone: 'red' | 'amber' | 'accent' | 'green' | 'muted'
  label: string
  title: string
}

export default function HealthBar({
  statuses,
  insights,
  claude,
  devServers,
  system,
  calendar,
  agentsWaiting = 0
}: Props): JSX.Element {
  const attention = statuses.filter((s) => deriveState(s).needsAttention).length
  const ciFail = Object.values(insights).filter((i) => i.ci === 'fail').length
  const reviews = Object.values(insights).reduce((n, i) => n + i.reviewRequests, 0)
  const activeAgents = claude?.projects.filter((p) => p.active).length ?? 0

  const chips: Chip[] = []

  // Blocked agents outrank everything — that's work stalled on a click.
  if (agentsWaiting > 0) {
    chips.push({
      key: 'waiting',
      tone: 'red',
      label: `${agentsWaiting} waiting on you`,
      title: 'Claude Code sessions blocked on a permission prompt or your reply — open the terminals panel'
    })
  }

  if (attention > 0) {
    chips.push({
      key: 'attention',
      tone: 'amber',
      label: `${attention} need${attention === 1 ? 's' : ''} attention`,
      title: 'Repositories with uncommitted, unpushed, unpulled, or upstream issues'
    })
  } else if (statuses.length > 0) {
    chips.push({ key: 'clean', tone: 'green', label: 'All repos clean', title: 'Everything committed and pushed' })
  }

  if (ciFail > 0) {
    chips.push({ key: 'ci', tone: 'red', label: `${ciFail} CI failing`, title: 'Repositories whose latest CI run failed' })
  }
  if (reviews > 0) {
    chips.push({ key: 'review', tone: 'accent', label: `${reviews} to review`, title: 'Open PRs requesting your review' })
  }
  if (claude && claude.costToday > 0) {
    chips.push({
      key: 'cost',
      tone: 'accent',
      label: `${fmtCost(claude.costToday)} Claude today`,
      title: `Estimated Claude Code spend today (${fmtCost(claude.costWeek)} this week)`
    })
  }
  if (activeAgents > 0) {
    chips.push({
      key: 'agents',
      tone: 'green',
      label: `${activeAgents} session${activeAgents === 1 ? '' : 's'} active`,
      title: 'Claude Code sessions active in the last few minutes'
    })
  }
  if (devServers.length > 0) {
    chips.push({
      key: 'servers',
      tone: 'accent',
      label: `${devServers.length} dev server${devServers.length === 1 ? '' : 's'} up`,
      title: devServers.map((s) => `:${s.port} ${s.command}`).join('\n')
    })
  }

  const evt = nextEvent(calendar)
  if (evt) {
    chips.push({ key: 'cal', tone: 'muted', label: evt, title: 'Next calendar event today' })
  }
  if (system) {
    const tone = system.cpu >= 85 || system.memPercent >= 90 ? 'amber' : 'muted'
    chips.push({
      key: 'sys',
      tone,
      label: `CPU ${system.cpu}% · RAM ${system.memPercent}%`,
      title: 'System load (1-min) and memory use'
    })
  }

  return (
    <div className="healthbar">
      {chips.length === 0 ? (
        <span className="health-chip tone-muted">No repositories imported yet</span>
      ) : (
        chips.map((c) => (
          <span key={c.key} className={`health-chip tone-${c.tone}`} title={c.title}>
            <span className="health-dot" />
            {c.label}
          </span>
        ))
      )}
    </div>
  )
}
