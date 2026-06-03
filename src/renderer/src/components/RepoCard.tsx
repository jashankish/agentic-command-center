import type {
  RepoStatus,
  RepoInsights,
  ClaudeProjectActivity,
  DevServer
} from '../../../shared/types'
import { deriveState } from '../lib/status'
import { fmtCost } from '../lib/format'
import {
  IconEditor,
  IconTerminal,
  IconFolder,
  IconExternal,
  IconDownload,
  IconSync,
  IconChevron,
  IconBranch,
  IconPlay,
  IconStar
} from './icons'

export type ActionKind = 'editor' | 'terminal' | 'reveal' | 'remote'

interface Props {
  status: RepoStatus
  insights?: RepoInsights
  claude?: ClaudeProjectActivity
  servers: DevServer[]
  scripts: string[]
  favorite: boolean
  group?: string
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onSync: () => void
  onRemove: () => void
  onFetch: () => void
  onAction: (kind: ActionKind) => void
  onRunScript: (name: string) => void
  onToggleFavorite: () => void
  onEditGroup: () => void
}

const CI_LABEL: Record<string, string> = {
  pass: 'CI passing',
  fail: 'CI failing',
  pending: 'CI running'
}

export default function RepoCard({
  status,
  insights,
  claude,
  servers,
  scripts,
  favorite,
  group,
  expanded,
  busy,
  onToggle,
  onSync,
  onRemove,
  onFetch,
  onAction,
  onRunScript,
  onToggleFavorite,
  onEditGroup
}: Props): JSX.Element {
  const state = deriveState(status)
  const commonScripts = scripts.filter((s) => ['dev', 'start', 'build', 'test', 'lint'].includes(s))
  const showCi = insights?.available && insights.ci !== 'none'

  return (
    <div className={`card card-${state.color} ${busy ? 'busy' : ''} ${favorite ? 'fav' : ''}`}>
      <span className="card-accent" />
      <button className="card-remove" title="Remove from list" onClick={onRemove}>
        ×
      </button>

      <div className="card-head">
        <button
          className={`card-star ${favorite ? 'on' : ''}`}
          title={favorite ? 'Unfavorite' : 'Favorite'}
          onClick={onToggleFavorite}
        >
          <IconStar filled={favorite} size={13} />
        </button>
        <span className={`card-dot dot-${state.color}`} />
        <div className="card-titles">
          <div className="card-name" title={status.path}>
            {status.name}
          </div>
          <div className="card-branch">
            <IconBranch />
            {status.branch ?? '—'}
            {status.lastCommitRelative && <span className="card-age"> · {status.lastCommitRelative}</span>}
          </div>
        </div>
        {showCi && (
          <span className={`ci-badge ci-${insights!.ci}`} title={CI_LABEL[insights!.ci] ?? ''}>
            {insights!.ci === 'pass' ? '✓' : insights!.ci === 'fail' ? '✕' : '…'}
          </span>
        )}
      </div>

      <div className={`card-badge badge-${state.color}`} title={state.detail}>
        {busy ? 'Working…' : state.badge}
      </div>

      <div className="card-chips">
        <button
          className={`chip chip-group ${group ? 'set' : ''}`}
          onClick={onEditGroup}
          title="Set group"
        >
          {group ? `# ${group}` : '# group'}
        </button>
        {claude && claude.costTotal > 0 && (
          <span
            className={`chip ${claude.active ? 'chip-live' : ''}`}
            title={`Claude: ${fmtCost(claude.costToday)} today · ${fmtCost(claude.costWeek)} week · ${fmtCost(
              claude.costTotal
            )} all-time · ${claude.sessions} session(s)`}
          >
            {claude.active && <span className="live-dot" />}
            {fmtCost(claude.costToday)} today
          </span>
        )}
        {servers.map((s) => (
          <a
            key={s.port}
            className="chip chip-server"
            href={`http://localhost:${s.port}`}
            target="_blank"
            rel="noreferrer"
            title={`${s.command} listening on :${s.port}`}
          >
            :{s.port}
          </a>
        ))}
        {insights?.available && insights.openPRs > 0 && (
          <span className="chip" title="Open pull requests">
            {insights.openPRs} PR{insights.openPRs === 1 ? '' : 's'}
          </span>
        )}
        {insights?.available && insights.reviewRequests > 0 && (
          <span className="chip chip-attn" title="PRs requesting your review">
            {insights.reviewRequests} to review
          </span>
        )}
        {insights?.available && insights.assignedIssues > 0 && (
          <span className="chip" title="Open issues assigned to you">
            {insights.assignedIssues} issue{insights.assignedIssues === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="card-actions">
        {state.canSync && (
          <button className="act primary" onClick={onSync} disabled={busy} title="Stage, commit & push">
            <IconSync /> Sync
          </button>
        )}
        {status.hasUpstream && (
          <button className="act" onClick={onFetch} disabled={busy} title="git fetch origin">
            <IconDownload />
          </button>
        )}
        <button className="act" onClick={() => onAction('editor')} title="Open in editor">
          <IconEditor />
        </button>
        <button className="act" onClick={() => onAction('terminal')} title="Open in Terminal">
          <IconTerminal />
        </button>
        <button className="act" onClick={() => onAction('reveal')} title="Reveal in Finder">
          <IconFolder />
        </button>
        {status.remoteUrl && (
          <button className="act" onClick={() => onAction('remote')} title="Open on GitHub">
            <IconExternal />
          </button>
        )}
        {(status.changedFiles.length > 0 || commonScripts.length > 0) && (
          <button className="act expand" onClick={onToggle} title="Details">
            <IconChevron open={expanded} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="card-detail">
          {status.lastCommitMessage && (
            <div className="detail-commit" title="Latest commit">
              {status.lastCommitMessage}
            </div>
          )}
          {status.changedFiles.length > 0 && (
            <ul className="detail-files">
              {status.changedFiles.slice(0, 12).map((f) => (
                <li key={f} title={f}>
                  {f}
                </li>
              ))}
              {status.changedFiles.length > 12 && (
                <li className="detail-more">+{status.changedFiles.length - 12} more</li>
              )}
            </ul>
          )}
          {commonScripts.length > 0 && (
            <div className="detail-scripts">
              {commonScripts.map((s) => (
                <button key={s} className="script-btn" onClick={() => onRunScript(s)} title={`npm run ${s}`}>
                  <IconPlay /> {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
