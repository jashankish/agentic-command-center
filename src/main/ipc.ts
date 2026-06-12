import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { getStatus, commitAndPush, fetchRepo } from './git'
import { getContributions } from './contributions'
import { getClaudeUsage } from './usage'
import { getInsights } from './insights'
import { getClaudeActivity } from './claude'
import { listDevServers, getScripts } from './devservers'
import {
  openInEditor,
  openInTerminal,
  revealInFinder,
  openRemote,
  runScript,
  launchAgent
} from './actions'
import { getInbox } from './inbox'
import { discoverRepos } from './discover'
import { getStandup } from './standup'
import { getSystemStats } from './system'
import { getCalendar } from './calendar'
import { getCommitFeed } from './commitfeed'
import { getTerminals, focusTerminal, activateHostApp } from './terminals'
import { getHooksStatus, installHooks, uninstallHooks } from './hooks-setup'
import { getAgentTimeline } from './agentevents'
import {
  listRepos,
  addRepo,
  removeRepo,
  getViewMode,
  setViewMode,
  getRepoMeta,
  setRepoMeta,
  getPanelPrefs,
  setPanelPrefs,
  exportSettings,
  importSettings
} from './store'
import type { ViewMode, RepoMeta, FocusTarget, PanelPrefs } from '../shared/types'

export function registerIpc(): void {
  ipcMain.handle('repos:list', () => listRepos())
  ipcMain.handle('repos:add', (_e, p: string) => addRepo(p))
  ipcMain.handle('repos:remove', (_e, p: string) => removeRepo(p))
  ipcMain.handle('repos:status', (_e, p: string) => getStatus(p))
  ipcMain.handle('repos:commitPush', (_e, p: string, message: string) => commitAndPush(p, message))
  ipcMain.handle('repos:fetch', (_e, p: string) => fetchRepo(p))
  ipcMain.handle('repos:insights', (_e, p: string) => getInsights(p))
  ipcMain.handle('repos:scripts', (_e, p: string) => getScripts(p))
  ipcMain.handle('repos:meta', () => getRepoMeta())
  ipcMain.handle('repos:setMeta', (_e, p: string, patch: RepoMeta) => setRepoMeta(p, patch))

  ipcMain.handle('actions:openEditor', (_e, p: string) => openInEditor(p))
  ipcMain.handle('actions:openTerminal', (_e, p: string) => openInTerminal(p))
  ipcMain.handle('actions:reveal', (_e, p: string) => revealInFinder(p))
  ipcMain.handle('actions:openRemote', (_e, p: string) => openRemote(p))
  ipcMain.handle('actions:runScript', (_e, p: string, name: string) => runScript(p, name))
  ipcMain.handle('actions:launchAgent', (_e, p: string) => launchAgent(p))

  ipcMain.handle('contrib:get', () => getContributions())
  ipcMain.handle('usage:get', () => getClaudeUsage())
  ipcMain.handle('claude:activity', (_e, paths: string[]) => getClaudeActivity(paths))
  ipcMain.handle('devservers:list', (_e, paths: string[]) => listDevServers(paths))
  ipcMain.handle('inbox:get', () => getInbox())
  ipcMain.handle('standup:get', (_e, paths: string[], sinceIso: string) =>
    getStandup(paths, sinceIso)
  )
  ipcMain.handle('system:get', () => getSystemStats())
  ipcMain.handle('calendar:get', () => getCalendar())
  ipcMain.handle('feed:get', (_e, paths: string[]) => getCommitFeed(paths))
  ipcMain.handle('terminals:list', (_e, paths: string[]) => getTerminals(paths))
  ipcMain.handle('terminals:focus', (_e, target: FocusTarget) => focusTerminal(target))

  ipcMain.handle('hooks:status', () => getHooksStatus())
  ipcMain.handle('hooks:install', (_e, detailed?: boolean) => installHooks(!!detailed))
  ipcMain.handle('hooks:uninstall', () => uninstallHooks())

  // Recent lifecycle events for the panel's Events tab, repo-resolved here so
  // the watcher module stays electron- and repo-agnostic.
  ipcMain.handle('sessions:timeline', (_e, paths: string[]) =>
    getAgentTimeline().map((ev) => ({
      ...ev,
      repoPath:
        ev.cwd === null
          ? null
          : (paths.find((r) => ev.cwd === r || ev.cwd!.startsWith(r + '/')) ?? null)
    }))
  )

  ipcMain.handle('terminals:activateApp', (_e, host: string) => activateHostApp(String(host)))

  ipcMain.handle('prefs:get', () => getPanelPrefs())
  ipcMain.handle('prefs:set', (_e, patch: Partial<PanelPrefs>) => setPanelPrefs(patch))

  // Dock badge: count of sessions blocked on the user (renderer computes it
  // alongside the health-bar chip; clearing means passing 0). A *rising*
  // count also bounces the dock icon once.
  let lastBadge = 0
  ipcMain.handle('badge:set', (_e, n: number) => {
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
    if (count > lastBadge) app.dock?.bounce('informational')
    lastBadge = count
    app.setBadgeCount(count)
  })

  ipcMain.handle('view:get', () => getViewMode())
  ipcMain.handle('view:set', (_e, mode: ViewMode) => setViewMode(mode))

  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select local git repositories',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('discover:scan', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose a folder to scan for git repositories',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return []
    return discoverRepos(result.filePaths[0])
  })

  ipcMain.handle('settings:export', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export settings',
      defaultPath: 'command-center-settings.json'
    })
    if (result.canceled || !result.filePath) return { success: false }
    try {
      await writeFile(result.filePath, JSON.stringify(exportSettings(), null, 2), 'utf8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('settings:import', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Import settings',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { success: false }
    try {
      const data = JSON.parse(await readFile(result.filePaths[0], 'utf8'))
      importSettings(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('window:isPinned', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return win?.isAlwaysOnTop() ?? false
  })

  ipcMain.handle('window:togglePin', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    const next = !win.isAlwaysOnTop()
    win.setAlwaysOnTop(next, 'floating')
    // Keep the docked feed window (a child of the main window) floating in step.
    for (const child of win.getChildWindows()) child.setAlwaysOnTop(next, 'floating')
    return next
  })
}
