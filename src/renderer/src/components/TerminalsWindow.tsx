import { useCallback, useEffect, useState } from 'react'
import type {
  AgentSessionState,
  AgentTimelineEvent,
  HooksStatus,
  PanelPrefs,
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
  const showTool =
    (agent.state === 'permission' || agent.state === 'working') && agent.detail?.tool
  return (
    <span className={`term-state term-state-${agent.state} conf-${agent.confidence}`} title={hint}>
      {STATE_LABEL[agent.state]}
      {showTool ? ` · ${agent.detail!.tool}` : ''}
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

const AUTOMATION_LABEL: Record<NonNullable<AgentSessionState['automation']>, string> = {
  loop: 'loop',
  cron: 'cron'
}

/** One row of the automations strip: the place, what kind of automation drives
 *  it, and the live state — flashing so a long-running loop stays noticeable. */
interface StripItem {
  key: string
  agent: AgentSessionState
  place: string | null
  onClick: (() => void) | undefined
}

/** The pop-out feed pinned beneath the terminal list: every active session
 *  driven by a /loop run or a scheduled (cron) prompt, kept in view and
 *  flashing its current status. Hidden entirely when nothing is looping. */
function AutomationStrip({ items }: { items: StripItem[] }): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="loop-strip">
      <div className="loop-strip-head">
        <span className="loop-strip-dot" />
        <span className="loop-strip-title">Looping now</span>
        <span className="loop-strip-count">{items.length}</span>
      </div>
      {items.map((it) => (
        <div
          key={it.key}
          className={`loop-row loop-row-${it.agent.state} ${it.onClick ? 'term-clickable' : ''}`}
          onClick={it.onClick}
          title={it.onClick ? 'Jump to this terminal' : undefined}
        >
          <span className={`loop-kind loop-kind-${it.agent.automation}`}>
            {AUTOMATION_LABEL[it.agent.automation!]}
          </span>
          <span className="loop-place">{it.place ?? 'claude'}</span>
          <span
            className={`term-state term-state-${it.agent.state} conf-${it.agent.confidence}`}
          >
            {STATE_LABEL[it.agent.state]}
          </span>
        </div>
      ))}
    </div>
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
  // Waiting > 5 minutes escalates the flash (faster, brighter).
  const stale =
    isWaiting(entry.agent) &&
    entry.agent!.since !== null &&
    Date.now() - new Date(entry.agent!.since).getTime() > 5 * 60_000
  const attn =
    entry.agent?.state === 'permission'
      ? `term-attn term-attn-permission${stale ? ' term-stale' : ''}`
      : entry.agent?.state === 'input'
        ? `term-attn term-attn-input${stale ? ' term-stale' : ''}`
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

function UnboundRow({
  session,
  onActivate
}: {
  session: UnboundSession
  onActivate: (host: string) => void
}): JSX.Element {
  const place = lastSegment(session.repoPath ?? session.cwd)
  // tmux's host is whichever terminal the client is attached to — not focusable.
  const clickable = !!session.host && session.host !== 'tmux'
  return (
    <div
      className={`term-entry term-unbound ${clickable ? 'term-clickable' : ''}`}
      onClick={clickable ? () => onActivate(session.host!) : undefined}
      title={clickable ? `Bring ${session.host} to the front` : undefined}
    >
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

function describeEvent(ev: AgentTimelineEvent): string {
  switch (ev.kind) {
    case 'start':
      return 'session started'
    case 'prompt':
      return ev.prompt ? `prompt: ${ev.prompt}` : 'prompt submitted'
    case 'permission':
      return `asked to use ${ev.detail?.tool ?? 'a tool'}${
        ev.detail?.summary ? ` — ${ev.detail.summary}` : ''
      }`
    case 'idle':
      return 'waiting for input'
    case 'stop':
      return 'turn finished'
    case 'end':
      return 'session ended'
  }
}

function TimelineRow({ ev }: { ev: AgentTimelineEvent }): JSX.Element {
  const place = lastSegment(ev.repoPath ?? ev.cwd) ?? ev.sessionId.slice(0, 8)
  return (
    <div className={`tl-entry tl-${ev.kind}`}>
      <div className="term-entry-top">
        <span className="term-chip">{place}</span>
        <span className="tl-text">{describeEvent(ev)}</span>
        <span className="tl-time">{relFromIso(ev.ts) ?? ''}</span>
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
  onInstall: (detailed: boolean) => void
  onUninstall: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [wantDetailed, setWantDetailed] = useState(false)

  if (hooks.installed) {
    return (
      <div className="term-hooks">
        <div className="term-hooks-row">
          <span className="term-hooks-status on">
            exact states on{hooks.detailed ? ' · detailed' : ''}
          </span>
          <span className="term-hooks-note">Claude Code reports session events directly</span>
          <button
            className="term-btn"
            disabled={busy}
            onClick={() => onInstall(!hooks.detailed)}
            title={
              hooks.detailed
                ? 'Drop the per-tool hooks (PreToolUse/PostToolUse)'
                : 'Also show which tool is running, via PreToolUse/PostToolUse (one recorder spawn around every tool call)'
            }
          >
            {hooks.detailed ? 'Less detail' : 'Per-tool detail'}
          </button>
          <button className="term-btn" disabled={busy} onClick={onUninstall}>
            Disable
          </button>
        </div>
        {hooks.error && <div className="term-hooks-error">{hooks.error}</div>}
      </div>
    )
  }

  return (
    <div className="term-hooks">
      {confirming ? (
        <div className="term-hooks-confirm">
          <p>
            This adds {wantDetailed ? 'eight' : 'six'} lifecycle hooks to{' '}
            <code>{homeShort(hooks.settingsPath)}</code> so sessions report exact states (which
            tool wants permission, when a turn finishes).{' '}
            {wantDetailed
              ? 'The per-tool hooks add one recorder spawn around every tool call.'
              : 'Nothing runs on tool calls, so Claude is not slowed down.'}{' '}
            Events are stored privately in this app&apos;s data folder and deleted when sessions
            end. A timestamped backup of your settings file is kept, and Disable removes exactly
            these entries.
          </p>
          <label className="term-hooks-option">
            <input
              type="checkbox"
              checked={wantDetailed}
              onChange={(e) => setWantDetailed(e.target.checked)}
            />
            Per-tool detail (&quot;working · Bash&quot;) via PreToolUse/PostToolUse
          </label>
          <pre className="term-hooks-preview">
            {wantDetailed ? hooks.previewDetailed : hooks.preview}
          </pre>
          <div className="term-hooks-actions">
            <button
              className="term-btn primary"
              disabled={busy}
              onClick={() => onInstall(wantDetailed)}
            >
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

/** Compact preference toggles: notification routing + plain-tab visibility. */
function PrefsRow({
  prefs,
  onPatch
}: {
  prefs: PanelPrefs
  onPatch: (patch: Partial<PanelPrefs>) => void
}): JSX.Element {
  const toggle = (
    key: keyof PanelPrefs,
    label: string,
    title: string
  ): JSX.Element => (
    <button
      className={`term-toggle ${prefs[key] ? 'active' : ''}`}
      onClick={() => onPatch({ [key]: !prefs[key] })}
      title={title}
    >
      {label}
    </button>
  )
  return (
    <div className="term-prefs-row">
      {toggle('notifyPermission', 'perm alerts', 'Notify when a session needs permission')}
      {toggle('notifyInput', 'turn alerts', 'Notify when a turn finishes (your turn)')}
      {toggle('notifyStale', 'stale nudge', 'One reminder when a session has waited 5+ minutes')}
      {toggle('showPlainTerminals', 'shell tabs', 'Show terminals that are not running Claude')}
    </div>
  )
}

/** Standalone terminals panel rendered inside its own docked window. Fetches
 *  and polls independently of the main command-center window. */
export default function TerminalsWindow(): JSX.Element {
  const [snap, setSnap] = useState<TerminalsSnapshot | null>(null)
  const [events, setEvents] = useState<AgentTimelineEvent[]>([])
  const [view, setView] = useState<'terminals' | 'events'>('terminals')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HooksStatus | null>(null)
  const [hooksBusy, setHooksBusy] = useState(false)
  const [prefs, setPrefs] = useState<PanelPrefs | null>(null)

  const load = useCallback(async () => {
    try {
      const repos = await window.api.listRepos()
      const [snapshot, timeline] = await Promise.all([
        window.api.getTerminals(repos),
        window.api.getAgentTimeline(repos)
      ])
      setSnap(snapshot)
      setEvents(timeline)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleInstallHooks = useCallback(async (detailed: boolean) => {
    setHooksBusy(true)
    try {
      setHooks(await window.api.installHooks(detailed))
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

  const handlePatchPrefs = useCallback(async (patch: Partial<PanelPrefs>) => {
    setPrefs(await window.api.setPanelPrefs(patch))
  }, [])

  const handleActivateHost = useCallback(async (host: string) => {
    const r = await window.api.activateHostApp(host)
    if (!r.success) {
      const msg = r.error ?? 'Could not focus that app.'
      setToast(msg)
      window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
    }
  }, [])

  useEffect(() => {
    window.api.getHooksStatus().then(setHooks)
    window.api.getPanelPrefs().then(setPrefs)
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
    const r = await window.api.focusTerminal({ app: entry.app, tty: entry.tty, tmux: entry.tmux })
    if (!r.success) {
      const msg = r.error ?? 'Could not focus that terminal.'
      setToast(msg)
      window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
    }
  }, [])

  const allEntries = [...(snap?.entries ?? [])].sort(
    (a, b) => rank(a.agent, a.busy) - rank(b.agent, b.busy)
  )
  // Hiding plain tabs is a visibility preference only — waiting counts and
  // notifications always consider everything.
  const entries =
    prefs && !prefs.showPlainTerminals ? allEntries.filter((e) => e.agent) : allEntries
  const unbound = snap?.unbound ?? []
  const waiting =
    allEntries.filter((e) => isWaiting(e.agent)).length +
    unbound.filter((s) => isWaiting(s)).length
  const denied: string[] = []
  if (snap?.automation.terminal === 'denied') denied.push('Terminal')
  if (snap?.automation.iterm === 'denied') denied.push('iTerm2')
  const empty = !loading && entries.length === 0 && unbound.length === 0

  // The automations pop-out draws from everything (independent of the plain-tab
  // visibility pref): enumerable tabs focus on click; tmux/elsewhere sessions
  // bring their host app forward when we know it.
  const automationItems: StripItem[] = [
    ...allEntries
      .filter((e) => e.agent?.automation)
      .map((e) => ({
        key: `e-${e.app}-${e.windowId}-${e.tabIndex}-${e.tty ?? 'no-tty'}`,
        agent: e.agent!,
        place: lastSegment(e.repoPath) ?? lastSegment(e.agent!.cwd ?? e.cwd),
        onClick: e.tty ? () => handleFocus(e) : undefined
      })),
    ...unbound
      .filter((s) => s.automation)
      .map((s) => ({
        key: `u-${s.pid}`,
        agent: s,
        place: lastSegment(s.repoPath ?? s.cwd),
        onClick:
          s.host && s.host !== 'tmux' ? () => handleActivateHost(s.host!) : undefined
      }))
  ]

  return (
    <div className="term-window">
      <div className="term-header">
        <div className="term-header-left">
          <button
            className={`term-tab ${view === 'terminals' ? 'active' : ''}`}
            onClick={() => setView('terminals')}
          >
            Terminals
          </button>
          <button
            className={`term-tab ${view === 'events' ? 'active' : ''}`}
            onClick={() => setView('events')}
          >
            Events
          </button>
          {waiting > 0 && <span className="term-wait-badge">{waiting} waiting on you</span>}
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

        {view === 'terminals' && (
          <>
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
              <EntryRow
                key={`${e.app}-${e.windowId}-${e.tabIndex}-${e.tty ?? 'no-tty'}`}
                entry={e}
                onFocus={handleFocus}
              />
            ))}

            {unbound.length > 0 && (
              <>
                <div className="term-section">Elsewhere</div>
                {unbound.map((s) => (
                  <UnboundRow key={`${s.pid}`} session={s} onActivate={handleActivateHost} />
                ))}
              </>
            )}
          </>
        )}

        {view === 'events' && (
          <>
            {!loading && events.length === 0 && (
              <div className="feed-empty">
                No agent events yet. Events appear for sessions covered by the exact-states hooks
                (or launched from the app).
              </div>
            )}
            {events.map((ev, i) => (
              <TimelineRow key={`${ev.sessionId}-${ev.ts}-${i}`} ev={ev} />
            ))}
          </>
        )}
      </div>

      <div className="term-footer">
        <AutomationStrip items={automationItems} />
        {prefs && <PrefsRow prefs={prefs} onPatch={handlePatchPrefs} />}
        {hooks && (
          <HooksCard
            hooks={hooks}
            busy={hooksBusy}
            onInstall={handleInstallHooks}
            onUninstall={handleUninstallHooks}
          />
        )}
      </div>

      {toast && <div className="toast term-toast">{toast}</div>}
    </div>
  )
}
