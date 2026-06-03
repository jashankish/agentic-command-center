import type { ClaudeActivity } from '../../../shared/types'
import { fmtCost } from '../lib/format'

/** Cost summary + recent plans, complementing the quota bars in UsageWidget. */
export default function ClaudePanel({ activity }: { activity: ClaudeActivity | null }): JSX.Element | null {
  if (!activity || !activity.available) return null
  if (activity.costTotal === 0 && activity.plans.length === 0) return null

  return (
    <div className="claude-panel">
      <div className="claude-totals">
        <span className="claude-stat" title="Estimated spend today">
          <span className="claude-stat-value">{fmtCost(activity.costToday)}</span>
          <span className="claude-stat-label">today</span>
        </span>
        <span className="claude-stat" title="Estimated spend in the last 7 days">
          <span className="claude-stat-value">{fmtCost(activity.costWeek)}</span>
          <span className="claude-stat-label">this week</span>
        </span>
        <span className="claude-stat" title="Estimated all-time spend across imported projects">
          <span className="claude-stat-value">{fmtCost(activity.costTotal)}</span>
          <span className="claude-stat-label">all-time</span>
        </span>
      </div>
      {activity.plans.length > 0 && (
        <div className="claude-plans-section">
          <div className="claude-plans-head" title="Plan files saved by Claude Code in ~/.claude/plans">
            Recent plans
          </div>
          <div className="claude-plans">
            {activity.plans.map((p) => (
              <span key={p} className="plan-chip" title={`~/.claude/plans/${p}.md`}>
                {p}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
