import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RepoStatus,
  RepoInsights,
  ClaudeActivity,
  DevServer,
  ViewMode,
  RepoMeta,
  Inbox,
  SystemStats,
  CalendarData,
  CommitFeed
} from '../../shared/types'
import RepoBox from './components/RepoBox'
import RepoCard, { type ActionKind } from './components/RepoCard'
import CommitDialog from './components/CommitDialog'
import ContributionGraph from './components/ContributionGraph'
import UsageWidget from './components/UsageWidget'
import ClaudePanel from './components/ClaudePanel'
import HealthBar from './components/HealthBar'
import InboxPanel from './components/InboxPanel'
import DiscoverDialog from './components/DiscoverDialog'
import StandupDialog from './components/StandupDialog'
import PromptDialog from './components/PromptDialog'
import InfoDialog from './components/InfoDialog'
import CommandPalette, { type Command } from './components/CommandPalette'
import CommitFeedPanel from './components/CommitFeedPanel'
import {
  IconRefresh,
  IconPlus,
  IconPin,
  IconLayout,
  IconGrid,
  IconSearch,
  IconClipboard,
  IconInfo,
  IconActivity
} from './components/icons'
import { deriveState } from './lib/status'
import { checkNotifications, requestNotifyPermission } from './lib/notify'

const nameOf = (p: string): string => p.split('/').pop() || p

export default function App(): JSX.Element {
  const [statuses, setStatuses] = useState<RepoStatus[]>([])
  const [insights, setInsights] = useState<Record<string, RepoInsights>>({})
  const [claude, setClaude] = useState<ClaudeActivity | null>(null)
  const [devServers, setDevServers] = useState<DevServer[]>([])
  const [scripts, setScripts] = useState<Record<string, string[]>>({})
  const [repoMeta, setRepoMeta] = useState<Record<string, RepoMeta>>({})
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [system, setSystem] = useState<SystemStats | null>(null)
  const [calendar, setCalendar] = useState<CalendarData | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [dialogPath, setDialogPath] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | undefined>()
  const [syncing, setSyncing] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [discoverFound, setDiscoverFound] = useState<string[] | null>(null)
  const [standupOpen, setStandupOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [groupEditPath, setGroupEditPath] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [feedOpen, setFeedOpen] = useState(false)
  const [feed, setFeed] = useState<CommitFeed | null>(null)
  const [feedLoading, setFeedLoading] = useState(false)
  const feedOpenRef = useRef(feedOpen)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const repos = await window.api.listRepos()
      const results = await Promise.all(repos.map((p) => window.api.getStatus(p)))
      setStatuses(results)
      const scriptEntries = await Promise.all(
        repos.map(async (p) => [p, (await window.api.getScripts(p)).scripts] as const)
      )
      setScripts(Object.fromEntries(scriptEntries))
    } finally {
      setRefreshing(false)
    }
  }, [])

  const loadDevServers = useCallback(async () => {
    const repos = await window.api.listRepos()
    setDevServers(await window.api.listDevServers(repos))
  }, [])

  const loadClaude = useCallback(async () => {
    const repos = await window.api.listRepos()
    setClaude(await window.api.getClaudeActivity(repos))
  }, [])

  const loadInsights = useCallback(async () => {
    const repos = await window.api.listRepos()
    const entries = await Promise.all(
      repos.map(async (p) => [p, await window.api.getInsights(p)] as const)
    )
    const map = Object.fromEntries(entries)
    setInsights(map)
    // Notify on transitions (CI failures, review requests, high usage).
    const usage = await window.api.getUsage()
    checkNotifications({ insights: map, nameOf, usage })
  }, [])

  const loadMeta = useCallback(async () => {
    setRepoMeta(await window.api.getRepoMeta())
  }, [])

  const loadInbox = useCallback(async () => setInbox(await window.api.getInbox()), [])
  const loadSystem = useCallback(async () => setSystem(await window.api.getSystemStats()), [])
  const loadCalendar = useCallback(async () => setCalendar(await window.api.getCalendar()), [])

  const loadFeed = useCallback(async () => {
    setFeedLoading(true)
    try {
      const repos = await window.api.listRepos()
      setFeed(await window.api.getCommitFeed(repos))
    } finally {
      setFeedLoading(false)
    }
  }, [])

  const handleToggleFeed = useCallback(async () => {
    const next = !feedOpenRef.current
    feedOpenRef.current = next
    setFeedOpen(next)
    const baseWidth = 760
    const panelWidth = 300
    await window.api.setWindowWidth(next ? baseWidth + panelWidth : baseWidth)
    if (next) loadFeed()
  }, [loadFeed])

  const reloadAll = useCallback(() => {
    refresh()
    loadDevServers()
    loadClaude()
    loadInsights()
    loadMeta()
    loadInbox()
  }, [refresh, loadDevServers, loadClaude, loadInsights, loadMeta, loadInbox])

  // Keep ref in sync so the interval closure always sees the latest value.
  useEffect(() => {
    feedOpenRef.current = feedOpen
  }, [feedOpen])

  useEffect(() => {
    reloadAll()
    loadSystem()
    loadCalendar()
    requestNotifyPermission()
    window.api.isPinned().then(setPinned)
    window.api.getViewMode().then(setViewMode)
    const fast = setInterval(() => {
      refresh()
      loadDevServers()
      loadSystem()
    }, 15000)
    const medium = setInterval(() => {
      loadClaude()
      loadInbox()
    }, 60000)
    const slow = setInterval(() => {
      loadInsights()
      loadCalendar()
    }, 300000)
    // Refresh the feed while it's open so summaries appear as ollama finishes.
    const feedPoll = setInterval(() => {
      if (feedOpenRef.current) loadFeed()
    }, 20000)
    return () => {
      clearInterval(fast)
      clearInterval(medium)
      clearInterval(slow)
      clearInterval(feedPoll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cmd/Ctrl-K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleImport = async (): Promise<void> => {
    const paths = await window.api.pickDirectory()
    for (const p of paths) await window.api.addRepo(p)
    if (paths.length) reloadAll()
  }

  const handleScan = async (): Promise<void> => {
    const found = await window.api.scanForRepos()
    if (found.length) setDiscoverFound(found)
    else flash('No git repositories found in that folder.')
  }

  const handleAddDiscovered = async (paths: string[]): Promise<void> => {
    for (const p of paths) await window.api.addRepo(p)
    setDiscoverFound(null)
    reloadAll()
  }

  const handleRemove = async (p: string): Promise<void> => {
    await window.api.removeRepo(p)
    reloadAll()
  }

  const handleTogglePin = async (): Promise<void> => setPinned(await window.api.togglePin())

  const handleToggleView = async (): Promise<void> => {
    const next: ViewMode = viewMode === 'dashboard' ? 'compact' : 'dashboard'
    setViewMode(await window.api.setViewMode(next))
  }

  const patchStatus = async (p: string): Promise<void> => {
    const updated = await window.api.getStatus(p)
    setStatuses((prev) => prev.map((s) => (s.path === p ? updated : s)))
  }

  const handleSync = async (message: string): Promise<void> => {
    if (!dialogPath) return
    setSyncing(true)
    setDialogError(undefined)
    try {
      const result = await window.api.commitPush(dialogPath, message)
      if (result.success) {
        await patchStatus(dialogPath)
        setDialogPath(null)
      } else {
        setDialogError(result.error ?? 'Sync failed.')
      }
    } finally {
      setSyncing(false)
    }
  }

  const handleFetch = async (p: string): Promise<void> => {
    setBusyPath(p)
    try {
      const r = await window.api.fetchRepo(p)
      if (r.success) await patchStatus(p)
      else flash(r.error ?? 'Fetch failed.')
    } finally {
      setBusyPath(null)
    }
  }

  const handleAction = async (p: string, kind: ActionKind): Promise<void> => {
    const fn = {
      editor: window.api.openEditor,
      terminal: window.api.openTerminal,
      reveal: window.api.reveal,
      remote: window.api.openRemote
    }[kind]
    const r = await fn(p)
    if (!r.success) flash(r.error ?? 'Action failed.')
  }

  const handleRunScript = async (p: string, name: string): Promise<void> => {
    const r = await window.api.runScript(p, name)
    if (!r.success) flash(r.error ?? 'Could not run script.')
  }

  const toggleFavorite = async (p: string): Promise<void> => {
    const map = await window.api.setRepoMeta(p, { favorite: !repoMeta[p]?.favorite })
    setRepoMeta(map)
  }

  const saveGroup = async (p: string, group: string): Promise<void> => {
    const map = await window.api.setRepoMeta(p, { group: group || undefined })
    setRepoMeta(map)
    setGroupEditPath(null)
  }

  const handleExport = async (): Promise<void> => {
    const r = await window.api.exportSettings()
    if (r.success) flash('Settings exported.')
    else if (r.error) flash(r.error)
  }

  const handleImportSettings = async (): Promise<void> => {
    const r = await window.api.importSettings()
    if (r.success) {
      setViewMode(await window.api.getViewMode())
      reloadAll()
      flash('Settings imported.')
    } else if (r.error) flash(r.error)
  }

  const dialogRepo = statuses.find((s) => s.path === dialogPath)
  const defaultMessage = `Update ${new Date().toLocaleString()}`

  const summary = statuses.reduce(
    (acc, s) => {
      acc[deriveState(s).color] += 1
      return acc
    },
    { green: 0, amber: 0, red: 0, gray: 0 }
  )

  const claudeFor = (p: string): ClaudeActivity['projects'][number] | undefined =>
    claude?.projects.find((x) => x.path === p)

  // Sort favorites first, then by group, then name. Build grouped sections only
  // when at least one repo has a group assigned.
  const sorted = useMemo(() => {
    return [...statuses].sort((a, b) => {
      const ga = repoMeta[a.path]?.group ?? '~'
      const gb = repoMeta[b.path]?.group ?? '~'
      if (ga !== gb) return ga.localeCompare(gb)
      const fa = repoMeta[a.path]?.favorite ? 0 : 1
      const fb = repoMeta[b.path]?.favorite ? 0 : 1
      if (fa !== fb) return fa - fb
      return a.name.localeCompare(b.name)
    })
  }, [statuses, repoMeta])

  const sections = useMemo(() => {
    const anyGroup = statuses.some((s) => repoMeta[s.path]?.group)
    if (!anyGroup) return [{ label: null as string | null, repos: sorted }]
    const out: Array<{ label: string | null; repos: RepoStatus[] }> = []
    for (const s of sorted) {
      const label = repoMeta[s.path]?.group ?? 'Ungrouped'
      const last = out[out.length - 1]
      if (last && last.label === label) last.repos.push(s)
      else out.push({ label, repos: [s] })
    }
    return out
  }, [sorted, statuses, repoMeta])

  const renderCard = (s: RepoStatus): JSX.Element => (
    <RepoCard
      key={s.path}
      status={s}
      insights={insights[s.path]}
      claude={claudeFor(s.path)}
      servers={devServers.filter((d) => d.repoPath === s.path)}
      scripts={scripts[s.path] ?? []}
      favorite={!!repoMeta[s.path]?.favorite}
      group={repoMeta[s.path]?.group}
      expanded={expanded === s.path}
      busy={busyPath === s.path || (syncing && dialogPath === s.path)}
      onToggle={() => setExpanded((e) => (e === s.path ? null : s.path))}
      onSync={() => {
        setDialogPath(s.path)
        setDialogError(undefined)
      }}
      onRemove={() => handleRemove(s.path)}
      onFetch={() => handleFetch(s.path)}
      onAction={(kind) => handleAction(s.path, kind)}
      onRunScript={(name) => handleRunScript(s.path, name)}
      onToggleFavorite={() => toggleFavorite(s.path)}
      onEditGroup={() => setGroupEditPath(s.path)}
    />
  )

  const commands = useMemo<Command[]>(() => {
    const global: Command[] = [
      { id: 'import', label: 'Import repositories…', run: handleImport },
      { id: 'scan', label: 'Scan folder for repositories…', run: handleScan },
      { id: 'standup', label: 'Standup digest', run: () => setStandupOpen(true) },
      { id: 'refresh', label: 'Refresh everything', run: reloadAll },
      {
        id: 'view',
        label: `Switch to ${viewMode === 'dashboard' ? 'compact' : 'dashboard'} view`,
        run: handleToggleView
      },
      { id: 'export', label: 'Export settings…', run: handleExport },
      { id: 'import-settings', label: 'Import settings…', run: handleImportSettings }
    ]
    const perRepo: Command[] = sorted.flatMap((s) => {
      const cmds: Command[] = [
        {
          id: `editor:${s.path}`,
          label: `Open ${s.name} in editor`,
          hint: s.path,
          run: () => handleAction(s.path, 'editor')
        },
        {
          id: `reveal:${s.path}`,
          label: `Reveal ${s.name} in Finder`,
          hint: s.path,
          run: () => handleAction(s.path, 'reveal')
        }
      ]
      if (s.remoteUrl) {
        cmds.push({
          id: `remote:${s.path}`,
          label: `Open ${s.name} on GitHub`,
          run: () => handleAction(s.path, 'remote')
        })
      }
      return cmds
    })
    return [...global, ...perRepo]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, viewMode])

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Agentic Command Center</span>
        </div>
        <div className="toolbar-actions">
          <button
            className={`icon-btn ${feedOpen ? 'active' : ''}`}
            onClick={handleToggleFeed}
            title={feedOpen ? 'Close activity feed' : 'Open activity feed'}
          >
            <IconActivity />
          </button>
          <button className="icon-btn" onClick={() => setPaletteOpen(true)} title="Command palette (⌘K)">
            <IconSearch />
          </button>
          <button className="icon-btn" onClick={() => setStandupOpen(true)} title="Standup digest">
            <IconClipboard />
          </button>
          <button className="icon-btn" onClick={() => setInfoOpen(true)} title="What everything means">
            <IconInfo />
          </button>
          <button
            className="icon-btn"
            onClick={handleToggleView}
            title={viewMode === 'dashboard' ? 'Switch to compact view' : 'Switch to dashboard view'}
          >
            {viewMode === 'dashboard' ? <IconGrid /> : <IconLayout />}
          </button>
          <button
            className={`icon-btn ${refreshing ? 'spinning' : ''}`}
            onClick={reloadAll}
            disabled={refreshing}
            title="Refresh"
          >
            <IconRefresh />
          </button>
          <button className="icon-btn" onClick={handleImport} title="Import repositories">
            <IconPlus />
          </button>
          <button
            className={`icon-btn ${pinned ? 'active' : ''}`}
            onClick={handleTogglePin}
            title={pinned ? 'Unpin (allow other windows on top)' : 'Pin always on top'}
          >
            <IconPin filled={pinned} />
          </button>
        </div>
      </header>

      <HealthBar
        statuses={statuses}
        insights={insights}
        claude={claude}
        devServers={devServers}
        system={system}
        calendar={calendar}
      />

      <h2 className="section-title">Repositories</h2>

      {statuses.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">+</span>
          <p>
            No repositories yet.
            <br />
            Tap <strong>+</strong> to import, or <strong>⌘K → Scan</strong> a folder.
          </p>
        </div>
      ) : viewMode === 'dashboard' ? (
        <div className="cards-scroll">
          {sections.map((sec) => (
            <div key={sec.label ?? '_'} className="card-section">
              {sec.label && <div className="group-head">{sec.label}</div>}
              <div className="cards">{sec.repos.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="grid">
            {sorted.map((s, i) => (
              <RepoBox
                key={s.path}
                index={i}
                status={s}
                busy={syncing && s.path === dialogPath}
                onSync={() => {
                  setDialogPath(s.path)
                  setDialogError(undefined)
                }}
                onRemove={() => handleRemove(s.path)}
              />
            ))}
          </div>
          <footer className="summary">
            {summary.green > 0 && (
              <span className="summary-item">
                <span className="summary-dot dot-green" />
                {summary.green} clean
              </span>
            )}
            {summary.amber > 0 && (
              <span className="summary-item">
                <span className="summary-dot dot-amber" />
                {summary.amber} to sync
              </span>
            )}
            {summary.red > 0 && (
              <span className="summary-item">
                <span className="summary-dot dot-red" />
                {summary.red} changed
              </span>
            )}
            {summary.gray > 0 && (
              <span className="summary-item">
                <span className="summary-dot dot-gray" />
                {summary.gray} other
              </span>
            )}
          </footer>
        </>
      )}

      {inbox?.available && (inbox.notifications.length > 0 || inbox.prs.length > 0) && (
        <>
          <h2 className="section-title">GitHub Inbox</h2>
          <InboxPanel inbox={inbox} />
        </>
      )}

      <h2 className="section-title">Claude Code Usage</h2>
      <UsageWidget />
      {viewMode === 'dashboard' && <ClaudePanel activity={claude} />}

      <h2 className="section-title">GitHub Contributions</h2>
      <ContributionGraph />

      {dialogRepo && (
        <CommitDialog
          repoName={dialogRepo.name}
          defaultMessage={defaultMessage}
          error={dialogError}
          busy={syncing}
          onSubmit={handleSync}
          onCancel={() => setDialogPath(null)}
        />
      )}

      {discoverFound && (
        <DiscoverDialog
          found={discoverFound}
          existing={new Set(statuses.map((s) => s.path))}
          onAdd={handleAddDiscovered}
          onCancel={() => setDiscoverFound(null)}
        />
      )}

      {standupOpen && (
        <StandupDialog
          claudeToday={claude?.costToday ?? 0}
          claudeWeek={claude?.costWeek ?? 0}
          onCancel={() => setStandupOpen(false)}
        />
      )}

      {groupEditPath && (
        <PromptDialog
          title={`Group for "${nameOf(groupEditPath)}"`}
          label="Assign a group label to organize the dashboard. Leave empty to clear."
          initial={repoMeta[groupEditPath]?.group ?? ''}
          placeholder="e.g. Work, Personal, Clients"
          onSubmit={(v) => saveGroup(groupEditPath, v)}
          onCancel={() => setGroupEditPath(null)}
        />
      )}

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}

      {infoOpen && <InfoDialog onClose={() => setInfoOpen(false)} />}

      {toast && <div className="toast">{toast}</div>}

      <CommitFeedPanel
        open={feedOpen}
        feed={feed}
        loading={feedLoading}
        onClose={handleToggleFeed}
      />
    </div>
  )
}
