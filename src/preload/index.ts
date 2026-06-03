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
  CalendarData
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
  getCalendar: (): Promise<CalendarData> => ipcRenderer.invoke('calendar:get')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
