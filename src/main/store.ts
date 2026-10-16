import Store from 'electron-store'
import type { ViewMode, RepoMeta, PanelPrefs, AwakeConfig } from '../shared/types'

const DEFAULT_PANEL_PREFS: PanelPrefs = {
  notifyPermission: true,
  notifyInput: false,
  notifyStale: true,
  showPlainTerminals: true
}

/** Awake-session defaults, the same as Insomnia's. */
const DEFAULT_AWAKE_CONFIG: AwakeConfig = {
  darkenDisplayOnLidClose: true,
  muteOnLidClose: true,
  lowPowerOnLidClose: true,
  freezeList: ['com.tinyspeck.slackmacgap', 'net.whatsapp.WhatsApp', 'com.hnc.Discord'],
  lowPowerFloor: 40,
  endFloor: 10,
  thermalRules: true
}

interface StoreSchema {
  repos: string[]
  viewMode: ViewMode
  repoMeta: Record<string, RepoMeta>
  panelPrefs: PanelPrefs
  awakeConfig: AwakeConfig
}

const store = new Store<StoreSchema>({
  defaults: {
    repos: [],
    viewMode: 'dashboard',
    repoMeta: {},
    panelPrefs: DEFAULT_PANEL_PREFS,
    awakeConfig: DEFAULT_AWAKE_CONFIG
  }
})

export function listRepos(): string[] {
  return store.get('repos')
}

export function addRepo(repoPath: string): string[] {
  const repos = store.get('repos')
  if (!repos.includes(repoPath)) {
    repos.push(repoPath)
    store.set('repos', repos)
  }
  return repos
}

export function removeRepo(repoPath: string): string[] {
  const repos = store.get('repos').filter((p) => p !== repoPath)
  store.set('repos', repos)
  const meta = store.get('repoMeta')
  if (meta[repoPath]) {
    delete meta[repoPath]
    store.set('repoMeta', meta)
  }
  return repos
}

export function getViewMode(): ViewMode {
  return store.get('viewMode')
}

export function setViewMode(mode: ViewMode): ViewMode {
  store.set('viewMode', mode)
  return mode
}

export function getRepoMeta(): Record<string, RepoMeta> {
  return store.get('repoMeta')
}

/** Merge a patch into one repo's metadata; clears the entry when it empties. */
export function setRepoMeta(repoPath: string, patch: RepoMeta): Record<string, RepoMeta> {
  const meta = store.get('repoMeta')
  const next: RepoMeta = { ...meta[repoPath], ...patch }
  if (!next.favorite) delete next.favorite
  if (!next.group) delete next.group
  if (Object.keys(next).length === 0) delete meta[repoPath]
  else meta[repoPath] = next
  store.set('repoMeta', meta)
  return meta
}

/** Terminals-panel preferences. Defaults fill any keys missing from disk so
 *  new preferences pick up their default on existing installs. */
export function getPanelPrefs(): PanelPrefs {
  return { ...DEFAULT_PANEL_PREFS, ...store.get('panelPrefs') }
}

export function setPanelPrefs(patch: Partial<PanelPrefs>): PanelPrefs {
  const next = { ...getPanelPrefs(), ...patch }
  store.set('panelPrefs', next)
  return next
}

export function getAwakeConfig(): AwakeConfig {
  return { ...DEFAULT_AWAKE_CONFIG, ...store.get('awakeConfig') }
}

/** Merge a patch, keeping the floors sane: the end floor stays below the Low
 *  Power floor (so Low Power Mode gets a chance first) unless it is 0 (off). */
export function setAwakeConfig(patch: Partial<AwakeConfig>): AwakeConfig {
  const next = { ...getAwakeConfig(), ...patch }
  const clamp = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)))
  next.lowPowerFloor = clamp(next.lowPowerFloor, 5, 95)
  next.endFloor = clamp(next.endFloor, 0, 90)
  if (next.endFloor >= next.lowPowerFloor) {
    if ('endFloor' in patch && !('lowPowerFloor' in patch)) {
      next.lowPowerFloor = Math.min(95, next.endFloor + 5)
    } else if (next.endFloor > 0) {
      next.endFloor = Math.max(0, next.lowPowerFloor - 5)
    }
  }
  next.freezeList = [...new Set(next.freezeList.filter((id) => typeof id === 'string' && id))]
  store.set('awakeConfig', next)
  return next
}

export interface Settings {
  repos: string[]
  viewMode: ViewMode
  repoMeta: Record<string, RepoMeta>
}

export function exportSettings(): Settings {
  return {
    repos: store.get('repos'),
    viewMode: store.get('viewMode'),
    repoMeta: store.get('repoMeta')
  }
}

/** Replace settings from an imported object (for moving between machines). */
export function importSettings(data: Partial<Settings>): Settings {
  if (Array.isArray(data.repos)) store.set('repos', data.repos)
  if (data.viewMode === 'compact' || data.viewMode === 'dashboard') {
    store.set('viewMode', data.viewMode)
  }
  if (data.repoMeta && typeof data.repoMeta === 'object') store.set('repoMeta', data.repoMeta)
  return exportSettings()
}
