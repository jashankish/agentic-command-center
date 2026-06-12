import { app } from 'electron'
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { HooksStatus } from '../shared/types'
import { redactError } from './redact'

/**
 * Opt-in installer for the Claude Code hooks behind exact session states
 * (plan §3, L3a). Principles, in order:
 *
 *  - Consent first: the renderer shows `preview` (the exact JSON to be
 *    merged) before install is ever called.
 *  - Never clobber: settings.json is parsed before writing; unparsable
 *    content aborts the operation. Writes are atomic (tmp + rename in the
 *    same directory, following a symlinked settings file to its target) and
 *    a timestamped backup of the previous file is kept beside it.
 *  - Surgical uninstall: our entries are identified by the hook command
 *    living under this app's userData dir — removal filters exactly those
 *    and leaves everything else (including other tools' hooks) untouched.
 *
 * The hook set deliberately avoids the per-tool-call hot path (no PreToolUse/
 * PostToolUse), so enabling this adds no latency to Claude's agentic loop.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd'
] as const

const NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt'

interface HookItem {
  type?: string
  command?: string
  [k: string]: unknown
}
interface HookGroup {
  matcher?: string
  hooks?: HookItem[]
  [k: string]: unknown
}
export interface SettingsShape {
  hooks?: Record<string, HookGroup[]>
  [k: string]: unknown
}

export function buildHookEntries(scriptPath: string): Record<string, HookGroup[]> {
  const entry = (matcher?: string): HookGroup => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: scriptPath }]
  })
  return {
    SessionStart: [entry()],
    UserPromptSubmit: [entry()],
    PermissionRequest: [entry()],
    Notification: [entry(NOTIFICATION_MATCHER)],
    Stop: [entry()],
    SessionEnd: [entry()]
  }
}

const hasCommandUnder = (g: HookGroup, dir: string): boolean =>
  (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.startsWith(dir))

/** Add our entries, replacing any previous copies (idempotent re-install). */
export function mergeHookSettings(settings: SettingsShape, scriptPath: string): SettingsShape {
  const ourDir = dirname(scriptPath)
  const merged: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) }
  for (const [event, groups] of Object.entries(buildHookEntries(scriptPath))) {
    merged[event] = [...(merged[event] ?? []).filter((g) => !hasCommandUnder(g, ourDir)), ...groups]
  }
  return { ...settings, hooks: merged }
}

/** Remove exactly our entries; prune groups/keys that become empty. */
export function removeHookSettings(settings: SettingsShape, ourDir: string): SettingsShape {
  if (!settings.hooks) return settings
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (groups ?? [])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter(
          (h) => !(typeof h.command === 'string' && h.command.startsWith(ourDir))
        )
      }))
      .filter((g) => (g.hooks ?? []).length > 0)
    if (kept.length > 0) hooks[event] = kept
  }
  const out: SettingsShape = { ...settings, hooks }
  if (Object.keys(hooks).length === 0) delete out.hooks
  return out
}

export function hookInstallState(
  settings: SettingsShape,
  scriptPath: string
): 'installed' | 'partial' | 'none' {
  const ourDir = dirname(scriptPath)
  const present = HOOK_EVENTS.filter((ev) =>
    (settings.hooks?.[ev] ?? []).some((g) => hasCommandUnder(g, ourDir))
  )
  if (present.length === HOOK_EVENTS.length) return 'installed'
  return present.length > 0 ? 'partial' : 'none'
}

/** The recorder itself: dependency-free /bin/sh, stdin → one JSON line.
 *  It never writes to stdout, so it cannot influence a permission decision. */
export function hookScript(eventsDir: string): string {
  return `#!/bin/sh
# Agentic Command Center — Claude Code session-event recorder.
# Appends one JSON line per hook event so the terminals panel can show exact
# session states. Reads stdin only and never writes to stdout (a permission
# decision can therefore never be influenced by this script). Managed by the
# app: enable/disable from the terminals panel.
EVENTS_DIR="${eventsDir}"
payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([a-zA-Z0-9-]*\\)".*/\\1/p' | head -n 1)
[ -n "$sid" ] || exit 0
mkdir -p "$EVENTS_DIR" 2>/dev/null
# The hook runs as a child of the claude process (sometimes via an
# intermediate shell): walk up to claude to capture its pid + controlling tty,
# which is what binds this session to a terminal tab.
pid=$PPID; tty=""; found=0; hops=0
while [ "$hops" -lt 6 ] && [ "$pid" -gt 1 ] 2>/dev/null; do
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || break
  case "$cmd" in
    *claude*) tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' '); found=1; break ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$pid" ] || break
  hops=$((hops + 1))
done
[ "$found" = 1 ] || pid=0
[ "$tty" = "??" ] && tty=""
printf '{"ts":"%s","pid":%s,"tty":"%s","event":%s}\\n' \\
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${pid:-0}" "$tty" "$payload" >> "$EVENTS_DIR/$sid.jsonl" 2>/dev/null
exit 0
`
}

// ─── Electron-aware wrappers ────────────────────────────────────────────────

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

export function hookPaths(): { scriptDir: string; scriptPath: string; eventsDir: string } {
  const base = app.getPath('userData')
  return {
    scriptDir: join(base, 'hooks'),
    scriptPath: join(base, 'hooks', 'record-session-event.sh'),
    eventsDir: join(base, 'agent-events')
  }
}

async function readSettings(): Promise<{ data: SettingsShape; path: string; existed: boolean }> {
  // Follow a symlinked settings file so tmp+rename lands on the real target.
  let target = SETTINGS_PATH
  try {
    target = await realpath(SETTINGS_PATH)
  } catch {
    // doesn't exist yet — we'll create it at the canonical path
  }
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: {}, path: target, existed: false }
    }
    throw err
  }
  // A parse failure must abort the whole operation — never clobber a file we
  // can't faithfully rewrite.
  const data = JSON.parse(raw) as SettingsShape
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('~/.claude/settings.json is not a JSON object')
  }
  return { data, path: target, existed: true }
}

async function writeSettings(path: string, data: SettingsShape, existed: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(path, `${path}.acc-backup-${stamp}`)
  }
  const tmp = `${path}.acc-tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

async function status(error?: string): Promise<HooksStatus> {
  const { scriptPath } = hookPaths()
  let state: 'installed' | 'partial' | 'none' = 'none'
  try {
    state = hookInstallState((await readSettings()).data, scriptPath)
  } catch {
    state = 'none'
  }
  return {
    installed: state === 'installed',
    partial: state === 'partial',
    scriptPath,
    settingsPath: SETTINGS_PATH,
    preview: JSON.stringify({ hooks: buildHookEntries(scriptPath) }, null, 2),
    error
  }
}

export async function getHooksStatus(): Promise<HooksStatus> {
  return status()
}

export async function installHooks(): Promise<HooksStatus> {
  try {
    const { scriptDir, scriptPath, eventsDir } = hookPaths()
    await mkdir(scriptDir, { recursive: true })
    await mkdir(eventsDir, { recursive: true, mode: 0o700 })
    await writeFile(scriptPath, hookScript(eventsDir), 'utf8')
    await chmod(scriptPath, 0o755)

    const { data, path, existed } = await readSettings()
    await writeSettings(path, mergeHookSettings(data, scriptPath), existed)
    return status()
  } catch (err) {
    return status(redactError(err))
  }
}

export async function uninstallHooks(): Promise<HooksStatus> {
  try {
    const { scriptDir, scriptPath } = hookPaths()
    const { data, path, existed } = await readSettings()
    if (existed) {
      await writeSettings(path, removeHookSettings(data, scriptDir), existed)
    }
    // Remove the script last: settings no longer reference it, and any claude
    // session mid-event simply finds it gone and moves on.
    await rm(scriptPath, { force: true })
    return status()
  } catch (err) {
    return status(redactError(err))
  }
}
