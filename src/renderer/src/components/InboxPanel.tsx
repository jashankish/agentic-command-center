import type { Inbox, CheckState } from '../../../shared/types'
import { relFromIso } from '../lib/format'

const CHECK_GLYPH: Record<CheckState, string> = {
  pass: '✓',
  fail: '✕',
  pending: '…',
  none: ''
}

const DECISION_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required'
}

export default function InboxPanel({ inbox }: { inbox: Inbox | null }): JSX.Element | null {
  if (!inbox || !inbox.available) return null
  if (inbox.notifications.length === 0 && inbox.prs.length === 0) return null

  return (
    <div className="inbox">
      {inbox.prs.length > 0 && (
        <div className="inbox-group">
          <div className="inbox-subhead">Your open PRs</div>
          {inbox.prs.slice(0, 8).map((pr) => (
            <a
              key={pr.url}
              className="inbox-row"
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              title={`${pr.repo} #${pr.number}`}
            >
              {pr.checks !== 'none' && (
                <span className={`inbox-check ci-${pr.checks}`}>{CHECK_GLYPH[pr.checks]}</span>
              )}
              <span className="inbox-title">{pr.title}</span>
              {pr.draft && <span className="inbox-tag">draft</span>}
              {pr.reviewDecision && (
                <span
                  className={`inbox-tag ${pr.reviewDecision === 'APPROVED' ? 'tag-green' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'tag-red' : ''}`}
                >
                  {DECISION_LABEL[pr.reviewDecision] ?? pr.reviewDecision.toLowerCase()}
                </span>
              )}
              <span className="inbox-repo">{pr.repo.split('/')[1] ?? pr.repo}</span>
            </a>
          ))}
        </div>
      )}

      {inbox.notifications.length > 0 && (
        <div className="inbox-group">
          <div className="inbox-subhead">Notifications</div>
          {inbox.notifications.slice(0, 10).map((n) => (
            <a
              key={n.id}
              className={`inbox-row ${n.unread ? 'unread' : ''}`}
              href={n.url ?? '#'}
              target="_blank"
              rel="noreferrer"
              title={`${n.reason.replace(/_/g, ' ')} · ${relFromIso(n.updatedAt) ?? ''}`}
            >
              {n.unread && <span className="inbox-unread-dot" />}
              <span className="inbox-title">{n.title}</span>
              <span className="inbox-repo">{n.repo.split('/')[1] ?? n.repo}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
