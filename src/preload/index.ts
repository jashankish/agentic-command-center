import { contextBridge, ipcRenderer } from 'electron'
import type {
  RepoStatus,
  CommitPushResult,
  ContributionData,
  ClaudeUsage,
  RepoInsights,
  RepoScripts,
  ClaudeActivity,
  DevServer,
  ViewMode,
  RepoMeta,
  Inbox,
  Standup,
  SystemStats,
  CalendarData,
  CommitFeed,
  TerminalsSnapshot,
  FocusTarget,
  HooksStatus,
  AgentTimelineEvent,
  PanelPrefs
} from '../shared/types'

const api = {
  listRepos: (): Promise<string[]> => ipcRenderer.invoke('repos:list'),
  addRepo: (p: string): Promise<string[]> => ipcRenderer.invoke('repos:add', p),
  removeRepo: (p: string): Promise<string[]> => ipcRenderer.invoke('repos:remove', p),
  getStatus: (p: string): Promise<RepoStatus> => ipcRenderer.invoke('repos:status', p),
  commitPush: (p: string, message: string): Promise<CommitPushResult> =>
    ipcRenderer.invoke('repos:commitPush', p, message),
  fetchRepo: (p: string): Promise<CommitPushResult> => ipcRenderer.invoke('repos:fetch', p),
  getInsights: (p: string): Promise<RepoInsights> => ipcRenderer.invoke('repos:insights', p),
  getScripts: (p: string): Promise<RepoScripts> => ipcRenderer.invoke('repos:scripts', p),
  getRepoMeta: (): Promise<Record<string, RepoMeta>> => ipcRenderer.invoke('repos:meta'),
  setRepoMeta: (p: string, patch: RepoMeta): Promise<Record<string, RepoMeta>> =>
    ipcRenderer.invoke('repos:setMeta', p, patch),

  openEditor: (p: string): Promise<CommitPushResult> => ipcRenderer.invoke('actions:openEditor', p),
  openTerminal: (p: string): Promise<CommitPushResult> =>
    ipcRenderer.invoke('actions:openTerminal', p),
  reveal: (p: string): Promise<CommitPushResult> => ipcRenderer.invoke('actions:reveal', p),
  openRemote: (p: string): Promise<CommitPushResult> => ipcRenderer.invoke('actions:openRemote', p),
  runScript: (p: string, name: string): Promise<CommitPushResult> =>
    ipcRenderer.invoke('actions:runScript', p, name),
  // New Terminal window at the repo running claude (with session tracking).
  launchAgent: (p: string): Promise<CommitPushResult> =>
    ipcRenderer.invoke('actions:launchAgent', p),

  pickDirectory: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickDirectory'),
  scanForRepos: (): Promise<string[]> => ipcRenderer.invoke('discover:scan'),
  exportSettings: (): Promise<CommitPushResult> => ipcRenderer.invoke('settings:export'),
  importSettings: (): Promise<CommitPushResult> => ipcRenderer.invoke('settings:import'),

  isPinned: (): Promise<boolean> => ipcRenderer.invoke('window:isPinned'),
  togglePin: (): Promise<boolean> => ipcRenderer.invoke('window:togglePin'),
  getViewMode: (): Promise<ViewMode> => ipcRenderer.invoke('view:get'),
  setViewMode: (mode: ViewMode): Promise<ViewMode> => ipcRenderer.invoke('view:set', mode),

  getContributions: (): Promise<ContributionData> => ipcRenderer.invoke('contrib:get'),
  getUsage: (): Promise<ClaudeUsage> => ipcRenderer.invoke('usage:get'),
  getClaudeActivity: (paths: string[]): Promise<ClaudeActivity> =>
    ipcRenderer.invoke('claude:activity', paths),
  listDevServers: (paths: string[]): Promise<DevServer[]> =>
    ipcRenderer.invoke('devservers:list', paths),
  getInbox: (): Promise<Inbox> => ipcRenderer.invoke('inbox:get'),
  getStandup: (paths: string[], sinceIso: string): Promise<Standup> =>
    ipcRenderer.invoke('standup:get', paths, sinceIso),
  getSystemStats: (): Promise<SystemStats> => ipcRenderer.invoke('system:get'),
  getCalendar: (): Promise<CalendarData> => ipcRenderer.invoke('calendar:get'),
  getCommitFeed: (paths: string[]): Promise<CommitFeed> => ipcRenderer.invoke('feed:get', paths),

  // Every open terminal tab/session plus live Claude session states.
  getTerminals: (paths: string[]): Promise<TerminalsSnapshot> =>
    ipcRenderer.invoke('terminals:list', paths),
  // Bring the terminal tab owning a tty to the front.
  focusTerminal: (target: FocusTarget): Promise<CommitPushResult> =>
    ipcRenderer.invoke('terminals:focus', target),

  // App-level focus for sessions in hosts we can't address per-tab.
  activateHostApp: (host: string): Promise<CommitPushResult> =>
    ipcRenderer.invoke('terminals:activateApp', host),
  // Recent Claude lifecycle events (Events tab), newest first.
  getAgentTimeline: (paths: string[]): Promise<AgentTimelineEvent[]> =>
    ipcRenderer.invoke('sessions:timeline', paths),
  // Terminals-panel preferences (notification routing + visibility).
  getPanelPrefs: (): Promise<PanelPrefs> => ipcRenderer.invoke('prefs:get'),
  setPanelPrefs: (patch: Partial<PanelPrefs>): Promise<PanelPrefs> =>
    ipcRenderer.invoke('prefs:set', patch),

  // Opt-in Claude Code hooks for exact session states.
  getHooksStatus: (): Promise<HooksStatus> => ipcRenderer.invoke('hooks:status'),
  installHooks: (detailed?: boolean): Promise<HooksStatus> =>
    ipcRenderer.invoke('hooks:install', detailed),
  uninstallHooks: (): Promise<HooksStatus> => ipcRenderer.invoke('hooks:uninstall'),
  // Hook events landed — refetch session state now instead of waiting a poll.
  onSessionsUpdate: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('sessions:update', handler)
    return () => ipcRenderer.removeListener('sessions:update', handler)
  },
  // Claude Code credentials changed (/login or token refresh) — refetch quota.
  onUsageUpdate: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('usage:update', handler)
    return () => ipcRenderer.removeListener('usage:update', handler)
  },
  // Dock badge count of sessions waiting on the user (0 clears it).
  setBadge: (n: number): Promise<void> => ipcRenderer.invoke('badge:set', n),

  // Show / hide the docked activity-feed window; resolves to the new open state.
  toggleFeed: (): Promise<boolean> => ipcRenderer.invoke('feed:toggle'),
  // Show / hide the docked terminals panel; resolves to the new open state.
  toggleTerminals: (): Promise<boolean> => ipcRenderer.invoke('terminals:toggle'),
  // Fires when the feed window is closed/destroyed externally (e.g. ⌘W) so the
  // main window can clear its toolbar toggle. Returns an unsubscribe function.
  onFeedClosed: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('feed:closed', handler)
    return () => ipcRenderer.removeListener('feed:closed', handler)
  },
  // Same, for the docked terminals panel.
  onTerminalsClosed: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('terminals:closed', handler)
    return () => ipcRenderer.removeListener('terminals:closed', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
