import { useCallback, useEffect, useState } from 'react'
import type {
  AgentSessionState,
  HooksStatus,
  TerminalEntry,
  TerminalsSnapshot,
  UnboundSession
} from '../../../shared/types'
import { relFromIso } from '../lib/format'

const STATE_LABEL: Record<AgentSessionState['state'], string> = {
  permission: 'needs permission',
  input: 'your turn',
  working: 'working',
  ended: 'ended',
  unknown: 'claude'
}

/** True when the session is blocked on the user. */
function isWaiting(agent: AgentSessionState | null | undefined): boolean {
  return agent?.state === 'permission' || agent?.state === 'input'
}

/** Attention first, then live agents, then plain busy tabs, then idle shells. */
function rank(agent: AgentSessionState | null, busy: boolean): number {
  if (agent?.state === 'permission') return 0
  if (agent?.state === 'input') return 1
  if (agent?.state === 'working') return 2
  if (agent) return 3
  return busy ? 4 : 5
}

const lastSegment = (p: string | null): string | null => (p ? p.split('/').pop() || p : null)

/** "3m ago" → "3m" for the compact waiting label. */
const waitingFor = (iso: string | null): string | null => {
  const rel = relFromIso(iso)
  return rel === null ? null : rel === 'just now' ? null : rel.replace(' ago', '')
}

function AgentBadge({ agent }: { agent: AgentSessionState }): JSX.Element {
  const wait = isWaiting(agent) ? waitingFor(agent.since) : null
  const hint =
    agent.confidence === 'heuristic'
      ? 'Inferred from the session transcript — enable phase-2 hooks for exact states'
      : 'Reported by Claude Code'
  return (
    <span className={`term-state term-state-${agent.state} conf-${agent.confidence}`} title={hint}>
      {STATE_LABEL[agent.state]}
      {agent.state === 'permission' && agent.detail?.tool ? ` · ${agent.detail.tool}` : ''}
      {wait ? ` · ${wait}` : ''}
    </span>
  )
}

function SessionMeta({ agent }: { agent: AgentSessionState }): JSX.Element | null {
  const task = agent.title || agent.lastPrompt
  if (!task) return null
  return (
    <p className="term-task" title={agent.lastPrompt ?? task}>
      {task}
    </p>
  )
}

const modelShort = (m?: string): string | null => {
  if (!m) return null
  return (
    ['fable', 'opus', 'sonnet', 'haiku'].find((k) => m.includes(k)) ??
    m.replace(/^claude-/, '').slice(0, 12)
  )
}

/** Compact telemetry chips: the session's model and (non-default) permission mode. */
function AgentChips({ agent }: { agent: AgentSessionState }): JSX.Element | null {
  const model = modelShort(agent.model)
  const mode =
    agent.permissionMode && agent.permissionMode !== 'default' ? agent.permissionMode : null
  if (!model && !mode) return null
  return (
    <>
      {model && <span className="term-chip">{model}</span>}
      {mode && (
        <span className="term-chip term-chip-mode" title="Claude Code permission mode">
          {mode}
        </span>
      )}
    </>
  )
}

function EntryRow({
  entry,
  onFocus
}: {
  entry: TerminalEntry
  onFocus: (entry: TerminalEntry) => void
}): JSX.Element {
  const repoName = lastSegment(entry.repoPath)
  const place = repoName ?? lastSegment(entry.agent?.cwd ?? entry.cwd)
  const title = entry.title || place || entry.command || entry.app
  const attn =
    entry.agent?.state === 'permission'
      ? 'term-attn term-attn-permission'
      : entry.agent?.state === 'input'
        ? 'term-attn term-attn-input'
        : ''
  const clickable = entry.tty !== null

  return (
    <div
      className={`term-entry ${attn} ${clickable ? 'term-clickable' : ''}`}
      onClick={clickable ? () => onFocus(entry) : undefined}
      title={clickable ? 'Jump to this terminal' : undefined}
    >
      <div className="term-entry-top">
        <span className="term-app-badge">{entry.app}</span>
        <span className="term-title">{title}</span>
        {entry.agent && <AgentBadge agent={entry.agent} />}
      </div>
      {entry.agent && <SessionMeta agent={entry.agent} />}
      <div className="term-entry-meta">
        {place && place !== title && <span className="term-chip">{place}</span>}
        {entry.agent && <AgentChips agent={entry.agent} />}
        {entry.command && <span className="term-cmd">{entry.command}</span>}
        {!entry.agent && entry.busy && <span className="term-chip term-chip-busy">busy</span>}
      </div>
    </div>
  )
}

function UnboundRow({ session }: { session: UnboundSession }): JSX.Element {
  const place = lastSegment(session.repoPath ?? session.cwd)
  return (
    <div className="term-entry term-unbound">
      <div className="term-entry-top">
        <span className="term-app-badge">{session.host ?? 'elsewhere'}</span>
        <span className="term-title">{place ?? 'claude'}</span>
        <AgentBadge agent={session} />
      </div>
      <SessionMeta agent={session} />
      <div className="term-entry-meta">
        <AgentChips agent={session} />
      </div>
    </div>
  )
}

const homeShort = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~')

/** Footer card driving the opt-in Claude Code hooks (exact session states).
 *  Consent-first: install only happens after the exact JSON is shown. */
function HooksCard({
  hooks,
  busy,
  onInstall,
  onUninstall
}: {
  hooks: HooksStatus
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)

  if (hooks.installed) {
    return (
      <div className="term-footer">
        <div className="term-hooks-row">
          <span className="term-hooks-status on">exact states on</span>
          <span className="term-hooks-note">Claude Code reports session events directly</span>
          <button className="term-btn" disabled={busy} onClick={onUninstall}>
            Disable
          </button>
        </div>
        {hooks.error && <div className="term-hooks-error">{hooks.error}</div>}
      </div>
    )
  }

  return (
    <div className="term-footer">
      {confirming ? (
        <div className="term-hooks-confirm">
          <p>
            This adds six lifecycle hooks to <code>{homeShort(hooks.settingsPath)}</code> so
            sessions report exact states (which tool wants permission, when a turn finishes).
            Nothing runs on tool calls, so Claude is not slowed down. Events are stored privately
            in this app&apos;s data folder and deleted when sessions end. A timestamped backup of
            your settings file is kept, and Disable removes exactly these entries.
          </p>
          <pre className="term-hooks-preview">{hooks.preview}</pre>
          <div className="term-hooks-actions">
            <button className="term-btn primary" disabled={busy} onClick={onInstall}>
              Add hooks
            </button>
            <button className="term-btn" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="term-hooks-row">
          <span className="term-hooks-status off">
            {hooks.partial ? 'exact states partial' : 'states are inferred'}
          </span>
          <button className="term-btn primary" disabled={busy} onClick={() => setConfirming(true)}>
            Enable exact states…
          </button>
        </div>
      )}
      {hooks.error && <div className="term-hooks-error">{hooks.error}</div>}
    </div>
  )
}

/** Standalone terminals panel rendered inside its own docked window. Fetches
 *  and polls independently of the main command-center window. */
export default function TerminalsWindow(): JSX.Element {
  const [snap, setSnap] = useState<TerminalsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HooksStatus | null>(null)
  const [hooksBusy, setHooksBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const repos = await window.api.listRepos()
      setSnap(await window.api.getTerminals(repos))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleInstallHooks = useCallback(async () => {
    setHooksBusy(true)
    try {
      setHooks(await window.api.installHooks())
    } finally {
      setHooksBusy(false)
    }
  }, [])

  const handleUninstallHooks = useCallback(async () => {
    setHooksBusy(true)
    try {
      setHooks(await window.api.uninstallHooks())
    } finally {
      setHooksBusy(false)
    }
  }, [])

  useEffect(() => {
    window.api.getHooksStatus().then(setHooks)
  }, [])

  // Hook events push state changes instantly — refresh without waiting a poll.
  useEffect(() => window.api.onSessionsUpdate(() => void load()), [load])

  useEffect(() => {
    load()
    // 5s keeps waiting-state changes snappy while the panel is visible; the
    // main process caches the underlying scan, so re-shows stay cheap. Skip
    // work while hidden — the OS reports it via the Page Visibility API.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 5000)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const handleFocus = useCallback(async (entry: TerminalEntry) => {
    if (!entry.tty) return
    const r = await window.api.focusTerminal({ app: entry.app, tty: entry.tty })
    if (!r.success) {
      const msg = r.error ?? 'Could not focus that terminal.'
      setToast(msg)
      window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
    }
  }, [])

  const entries = [...(snap?.entries ?? [])].sort(
    (a, b) => rank(a.agent, a.busy) - rank(b.agent, b.busy)
  )
  const unbound = snap?.unbound ?? []
  const waiting =
    entries.filter((e) => isWaiting(e.agent)).length + unbound.filter((s) => isWaiting(s)).length
  const denied: string[] = []
  if (snap?.automation.terminal === 'denied') denied.push('Terminal')
  if (snap?.automation.iterm === 'denied') denied.push('iTerm2')
  const empty = !loading && entries.length === 0 && unbound.length === 0

  return (
    <div className="term-window">
      <div className="term-header">
        <div className="term-header-left">
          <span className="term-window-title">Terminals</span>
          {waiting > 0 && (
            <span className="term-wait-badge">
              {waiting} waiting on you
            </span>
          )}
        </div>
      </div>

      <div className="term-body">
        {loading && !snap && (
          <div className="feed-loading">
            <span className="feed-dot" />
            <span className="feed-dot" />
            <span className="feed-dot" />
          </div>
        )}

        {denied.length > 0 && (
          <div className="term-notice">
            Grant Automation access to list {denied.join(' and ')} windows: System Settings →
            Privacy &amp; Security → Automation → Agentic Command Center.
          </div>
        )}

        {empty && (
          <div className="feed-empty">
            No terminals found.
            {snap?.automation.terminal === 'not-running' &&
              snap?.automation.iterm === 'not-running' &&
              ' Neither Terminal nor iTerm2 is running.'}
          </div>
        )}

        {entries.map((e) => (
          <EntryRow key={`${e.app}-${e.windowId}-${e.tabIndex}-${e.tty ?? 'no-tty'}`} entry={e} onFocus={handleFocus} />
        ))}

        {unbound.length > 0 && (
          <>
            <div className="term-section">Elsewhere</div>
            {unbound.map((s) => (
              <UnboundRow key={`${s.pid}`} session={s} />
            ))}
          </>
        )}
      </div>

      {hooks && (
        <HooksCard
          hooks={hooks}
          busy={hooksBusy}
          onInstall={handleInstallHooks}
          onUninstall={handleUninstallHooks}
        />
      )}

      {toast && <div className="toast term-toast">{toast}</div>}
    </div>
  )
}
