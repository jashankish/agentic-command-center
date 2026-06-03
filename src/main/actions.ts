import { execFile } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import { simpleGit } from 'simple-git'
import type { CommitPushResult } from '../shared/types'
import { webUrlFromRemote } from './git'
import { redactError } from './redact'

const execFileAsync = promisify(execFile)

// macOS bundle identifiers / app names to try, in order, for "open in editor".
const EDITORS = ['Cursor', 'Visual Studio Code', 'Zed', 'Sublime Text']

async function openWith(appName: string, target: string): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/open', ['-a', appName, target])
    return true
  } catch {
    return false
  }
}

export async function openInEditor(repoPath: string): Promise<CommitPushResult> {
  for (const app of EDITORS) {
    if (await openWith(app, repoPath)) return { success: true }
  }
  return { success: false, error: 'No supported editor found (Cursor, VS Code, Zed, Sublime).' }
}

export async function openInTerminal(repoPath: string): Promise<CommitPushResult> {
  if (await openWith('Terminal', repoPath)) return { success: true }
  return { success: false, error: 'Could not open Terminal.' }
}

export async function revealInFinder(repoPath: string): Promise<CommitPushResult> {
  const err = await shell.openPath(repoPath)
  return err ? { success: false, error: err } : { success: true }
}

export async function openRemote(repoPath: string): Promise<CommitPushResult> {
  try {
    const remote = (await simpleGit(repoPath).remote(['get-url', 'origin'])) as string
    const url = webUrlFromRemote(remote)
    if (!url) return { success: false, error: 'No browsable remote URL for origin.' }
    await shell.openExternal(url)
    return { success: true }
  } catch (err) {
    return { success: false, error: redactError(err) }
  }
}

/**
 * Run an npm script in a new Terminal window so its output is visible and the
 * process is owned by the user's shell (not this app). Uses AppleScript.
 */
export async function runScript(repoPath: string, name: string): Promise<CommitPushResult> {
  // Only allow plain script names — defense against AppleScript injection.
  if (!/^[\w.:-]+$/.test(name)) {
    return { success: false, error: 'Invalid script name.' }
  }
  const cmd = `cd ${JSON.stringify(repoPath)} && npm run ${name}`
  const script = `tell application "Terminal"
    activate
    do script ${JSON.stringify(cmd)}
  end tell`
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script])
    return { success: true }
  } catch (err) {
    return { success: false, error: redactError(err) }
  }
}
