import { app, BrowserWindow, net, Notification, powerMonitor, powerSaveBlocker, screen } from 'electron'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { homedir, userInfo } from 'os'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { getAwakeConfig, setAwakeConfig, listRepos } from './store'
import { getTerminals } from './terminals'
import { nudgeMarkedPanes } from './tmux'
import { relaunchUnthrottled, scanThrottledBrowsers, type ThrottledBrowser } from './browsers'
import type {
  AppNapOverride,
  AwakeConfig,
  AwakeEndReason,
  AwakeMode,
  AwakeSession,
  AwakeState,
  FrozenProcess
} from '../shared/types'

/**
 * Awake sessions: keep the Mac awake — lid closed included — until a
 * user-chosen end time, then put everything back.
 *
 * Sleep is held by `pmset -a disablesleep 1`, run through a passwordless
 * sudoers rule limited to four exact pmset commands (the same four Insomnia
 * uses, so either app's rule works for both). Without the rule a power
 * assertion still keeps the Mac awake while the lid is open.
 *
 * Every change is written to a journal *before* it is made, so a crash never
 * leaves something changed that nothing remembers. On launch the journal is
 * reconciled, and a launchd backstop undoes an expired session's changes if
 * the app is gone when it should have ended.
 */

const PMSET = '/usr/bin/pmset'
const SUDO = '/usr/bin/sudo'
const SUDOERS_FILE = '/etc/sudoers.d/agentic-command-center'
const BACKSTOP_LABEL = 'com.jashan.agenticcommandcenter.awake-backstop'
const MAX_SESSION_S = 30 * 24 * 3600
const MIN_SESSION_S = 60
/** Agent-aware extension: step size and the most it may add in total. */
const AGENT_STEP_S = 15 * 60
const AGENT_CAP_S = 12 * 3600
/** Length of a session the agent watcher starts (then agent-extended). */
const AUTO_START_S = 30 * 60
/** How often the agent watcher looks for working Claude sessions. */
const AUTO_WATCH_MS = 60_000
/** An outage at least this long earns marked tmux panes a `continue`. */
const NUDGE_AFTER_MS = 90_000

/** Apps the freeze list may never stop: system processes, agent hosts and
 *  terminals (the work the session exists for), and this app. */
const FREEZE_DENYLIST = new Set([
  'com.jashan.agenticcommandcenter',
  'com.github.Electron',
  'com.anthropic.claudefordesktop',
  'com.openai.codex',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'com.microsoft.VSCode',
  'com.todesktop.230313mzl4w4u92',
  'dev.zed.Zed',
  'com.docker.docker',
  'io.tailscale.ipn.macsys'
])

interface Runtime {
  sleepDisabledByUs: boolean
  lowPowerByUs: boolean
  mutedByUs: boolean
  frozen: FrozenProcess[]
  appNap: AppNapOverride[]
}

interface Journal {
  version: 1
  session: AwakeSession | null
  mode: AwakeMode | null
  /** Session end as epoch seconds, for the shell backstop. */
  endsAtEpoch: number
  appPid: number
  /** `ps -o lstart=` of this app, whitespace-collapsed; proves `appPid` is us. */
  appStartedAt: string
  runtime: Runtime
}

const cleanRuntime = (): Runtime => ({
  sleepDisabledByUs: false,
  lowPowerByUs: false,
  mutedByUs: false,
  frozen: [],
  appNap: []
})

const runtimeDirty = (r: Runtime): boolean =>
  r.sleepDisabledByUs || r.lowPowerByUs || r.mutedByUs || r.frozen.length > 0 || r.appNap.length > 0

// ---------- process helpers ----------

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** Killed for running past its timeout. */
  timedOut: boolean
}

function run(file: string, args: string[], timeout = 20_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), timedOut })
    })
  })
}

/** `sudo -n pmset …` — never prompts; fails fast if the sudoers rule is missing. */
async function sudoPmset(args: string[]): Promise<RunResult> {
  return run(SUDO, ['-n', PMSET, ...args])
}

/** `ps` start time, whitespace-collapsed so the shell backstop compares equal. */
async function processStart(pid: number): Promise<string | null> {
  const r = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 5000)
  const s = r.stdout.trim().replace(/\s+/g, ' ')
  return r.ok && s ? s : null
}

async function isSleepDisabled(): Promise<boolean> {
  const r = await run(PMSET, ['-g'], 10_000)
  return /SleepDisabled\s+1/.test(r.stdout)
}

/** Battery-profile Low Power Mode (what `pmset -b lowpowermode` sets). */
async function isLowPowerOn(): Promise<boolean | null> {
  const r = await run(PMSET, ['-g', 'custom'], 10_000)
  if (!r.ok) return null
  const battery = r.stdout.split(/^AC Power:/m)[0].split(/^Battery Power:/m)[1] ?? r.stdout
  const m = /lowpowermode\s+(\d)/.exec(battery)
  return m ? m[1] === '1' : null
}

async function readBattery(): Promise<{ onBattery: boolean; percent: number | null }> {
  // Test hook: ACC_SIMULATE_BATTERY=<file> holding e.g. `35 battery` or `80 ac`.
  const simulated = process.env.ACC_SIMULATE_BATTERY
  if (simulated) {
    try {
      const [pct, source] = (await readFile(simulated, 'utf8')).trim().split(/\s+/)
      return { onBattery: source === 'battery', percent: Number.isFinite(Number(pct)) ? Number(pct) : null }
    } catch {
      return { onBattery: false, percent: null }
    }
  }
  const r = await run(PMSET, ['-g', 'batt'], 10_000)
  const pct = /(\d+)%/.exec(r.stdout)
  return {
    onBattery: /'Battery Power'/.test(r.stdout),
    percent: pct ? Number(pct[1]) : null
  }
}

async function readLidClosed(): Promise<boolean> {
  // Test hook: exercise the lid-close actions without closing the lid
  // (`echo closed > $ACC_SIMULATE_LID`), like Insomnia's simulate-lid.sh.
  const simulated = process.env.ACC_SIMULATE_LID
  if (simulated) {
    try {
      return (await readFile(simulated, 'utf8')).trim() === 'closed'
    } catch {
      return false
    }
  }
  const r = await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'], 5000)
  return /"AppleClamshellState"\s*=\s*Yes/.test(r.stdout)
}

/** An external display is attached. Test hook: ACC_SIMULATE_DISPLAY=<file>
 *  reads `external` / `internal` from the file instead. */
async function hasExternalDisplay(): Promise<boolean> {
  const simulated = process.env.ACC_SIMULATE_DISPLAY
  if (simulated) {
    try {
      return (await readFile(simulated, 'utf8')).trim() === 'external'
    } catch {
      return false
    }
  }
  try {
    return screen.getAllDisplays().some((d) => !d.internal)
  } catch {
    return false
  }
}

/** Lid state plus whether nobody is at the Mac: a closed lid with an external
 *  display attached is clamshell use, not "walked away". */
async function readLid(): Promise<{ closed: boolean; clamshell: boolean; away: boolean }> {
  const closed = await readLidClosed()
  const clamshell = closed && (await hasExternalDisplay())
  return { closed, clamshell, away: closed && !clamshell }
}

async function isMuted(): Promise<boolean | null> {
  const r = await run('/usr/bin/osascript', ['-e', 'output muted of (get volume settings)'], 5000)
  if (!r.ok) return null
  return r.stdout.trim() === 'true'
}

async function setMuted(muted: boolean): Promise<boolean> {
  const cmd = muted ? 'set volume with output muted' : 'set volume without output muted'
  return (await run('/usr/bin/osascript', ['-e', cmd], 5000)).ok
}

// ---------- app bundles (freeze list) ----------

const bundlePathCache = new Map<string, string>()

/** Where an app bundle lives. A running app is asked of LaunchServices first —
 *  it knows bundles Spotlight never indexed (hidden folders, external disks,
 *  Spotlight off), and only running apps can be frozen anyway. Spotlight is
 *  the fallback for display names. Only hits are cached, so an app installed
 *  after launch is still found. */
async function bundlePath(bundleId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) return null
  const running = await run('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath', bundleId], 5000)
  const live = /"LSBundlePath"="([^"]+)"/.exec(running.stdout)?.[1]
  if (live) {
    bundlePathCache.set(bundleId, live)
    return live
  }
  const cached = bundlePathCache.get(bundleId)
  if (cached) return cached
  const r = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], 10_000)
  const path = r.stdout.split('\n').find((p) => p.endsWith('.app')) ?? null
  if (path) bundlePathCache.set(bundleId, path)
  return path
}

/** Accept a bundle id or an app name ("Slack") and resolve it to both. */
export async function resolveApp(
  input: string
): Promise<{ bundleId: string; name: string } | { error: string }> {
  const q = input.trim()
  if (!q) return { error: 'Enter an app name or bundle id.' }
  let bundleId = q
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(q)) {
    const safe = q.replace(/["\\]/g, '')
    const r = await run('/usr/bin/osascript', ['-e', `id of application "${safe}"`], 10_000)
    if (!r.ok || !r.stdout.trim()) return { error: `No app named "${q}" was found.` }
    bundleId = r.stdout.trim()
  }
  if (bundleId.startsWith('com.apple.') || FREEZE_DENYLIST.has(bundleId)) {
    return { error: 'That app keeps your agents or macOS running, so it is never frozen.' }
  }
  const path = await bundlePath(bundleId)
  return { bundleId, name: path ? basename(path, '.app') : bundleId }
}

interface ProcRow {
  pid: number
  stat: string
  startedAt: string
  command: string
}

async function listProcesses(): Promise<ProcRow[]> {
  const r = await run('/bin/ps', ['-axww', '-o', 'pid=,stat=,lstart=,comm='], 10_000)
  const rows: ProcRow[] = []
  for (const line of r.stdout.split('\n')) {
    // pid, stat, then lstart's five fields ("Fri Oct 16 17:06:34 2026"), then the path.
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line)
    if (m) {
      rows.push({
        pid: Number(m[1]),
        stat: m[2],
        startedAt: m[3].replace(/\s+/g, ' '),
        command: m[4]
      })
    }
  }
  return rows
}

// ---------- module state ----------

let dir = ''
let journalPath = ''
let journal: Journal | null = null
let blockerId: number | null = null
let endTimer: NodeJS.Timeout | null = null
let tickTimer: NodeJS.Timeout | null = null
let lidTimer: NodeJS.Timeout | null = null
let batteryTimer: NodeJS.Timeout | null = null
let netTimer: NodeJS.Timeout | null = null
let appStartedAt = ''
let quitting = false
/** Serializes start / extend / end / lid / floor work so they never interleave. */
let chain: Promise<unknown> = Promise.resolve()

const live = {
  lidReady: false,
  lidClosed: false,
  onBattery: false,
  batteryPercent: null as number | null,
  thermal: 'unknown' as AwakeState['thermal'],
  foreignSleepHold: false,
  warnings: [] as string[],
  lastEnd: null as AwakeState['lastEnd'],
  agentsWorking: 0,
  /** Lid closed with an external display: in use, so lid actions are skipped. */
  clamshell: false,
  offlineSince: null as number | null,
  throttledBrowsers: [] as ThrottledBrowser[]
}

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

function warn(msg: string): void {
  if (!live.warnings.includes(msg)) live.warnings.push(msg)
}

function clearWarnings(): void {
  live.warnings = []
}

function emptyJournal(): Journal {
  return {
    version: 1,
    session: null,
    mode: null,
    endsAtEpoch: 0,
    appPid: process.pid,
    appStartedAt,
    runtime: cleanRuntime()
  }
}

/** Atomic, owner-only journal write. Throws so callers never change what
 *  they could not record. */
async function writeJournal(j: Journal): Promise<void> {
  j.appPid = process.pid
  j.appStartedAt = appStartedAt
  const tmp = `${journalPath}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(j, null, 2), { mode: 0o600 })
  await rename(tmp, journalPath)
  journal = j
}

async function readJournal(): Promise<Journal | null> {
  try {
    const j = JSON.parse(await readFile(journalPath, 'utf8')) as Journal
    if (!j || typeof j !== 'object' || !j.runtime) return null
    j.runtime = {
      ...cleanRuntime(),
      ...j.runtime,
      frozen: j.runtime.frozen ?? [],
      appNap: j.runtime.appNap ?? []
    }
    return j
  } catch {
    return null
  }
}

function J(): Journal {
  if (!journal) journal = emptyJournal()
  return journal
}

// ---------- state push ----------

let freezeNames: Record<string, string> = {}
const appNapNames: Record<string, string> = {}

async function refreshFreezeNames(config: AwakeConfig): Promise<void> {
  const out: Record<string, string> = {}
  for (const id of config.freezeList) {
    const path = await bundlePath(id)
    out[id] = path ? basename(path, '.app') : id
  }
  freezeNames = out
}

export function getAwakeState(): AwakeState {
  const j = J()
  const config = getAwakeConfig()
  return {
    session: j.session,
    mode: j.session ? j.mode : null,
    lidReady: live.lidReady,
    ruleOwned: existsSync(SUDOERS_FILE),
    lidClosed: live.lidClosed,
    clamshell: live.clamshell,
    onBattery: live.onBattery,
    batteryPercent: live.batteryPercent,
    thermal: live.thermal,
    lowPowerByUs: j.runtime.lowPowerByUs,
    mutedByUs: j.runtime.mutedByUs,
    frozen: j.runtime.frozen,
    foreignSleepHold: live.foreignSleepHold,
    warnings: [...live.warnings],
    config,
    freezeApps: config.freezeList.map((id) => ({ bundleId: id, name: freezeNames[id] ?? id })),
    lastEnd: live.lastEnd,
    restorePending: !j.session && runtimeDirty(j.runtime),
    agentsWorking: live.agentsWorking,
    offlineSince: live.offlineSince ? new Date(live.offlineSince).toISOString() : null,
    throttledBrowsers: live.throttledBrowsers,
    appNapApps: j.runtime.appNap.map((o) => appNapNames[o.bundleId] ?? o.bundleId)
  }
}

function push(): void {
  const state = getAwakeState()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('awake:update', state)
  }
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
}

// ---------- sudoers setup ----------

export async function checkLidReady(): Promise<boolean> {
  const r = await run(SUDO, ['-n', '-l', PMSET, '-a', 'disablesleep', '1'], 10_000)
  live.lidReady = r.ok
  return r.ok
}

/** AppleScript string literal for a shell command. */
const asString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

async function withAdmin(shell: string): Promise<RunResult> {
  return run(
    '/usr/bin/osascript',
    [
      '-e',
      `do shell script ${asString(shell)} with prompt ${asString(
        'Agentic Command Center wants to let your account run four pmset commands without a password, so awake sessions can keep the Mac awake with the lid closed.'
      )} with administrator privileges`
    ],
    120_000
  )
}

/** Install the four-command sudoers rule (validated with visudo first). */
export async function installLidSetup(): Promise<AwakeState> {
  const user = userInfo().username
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) {
    warn(`Can't write a sudoers rule for the account name "${user}".`)
    push()
    return getAwakeState()
  }
  const rule =
    `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 1, ${PMSET} -a disablesleep 0, ` +
    `${PMSET} -b lowpowermode 1, ${PMSET} -b lowpowermode 0`
  const script = [
    'tmp=$(/usr/bin/mktemp /tmp/acc-sudoers.XXXXXX) || exit 1',
    `printf '%s\\n' '${rule}' > "$tmp"`,
    '/usr/sbin/visudo -cf "$tmp" >/dev/null',
    'rc=$?',
    `[ $rc -eq 0 ] && /usr/bin/install -m 0440 -o root -g wheel "$tmp" ${SUDOERS_FILE}`,
    'rc2=$?',
    '/bin/rm -f "$tmp"',
    '[ $rc -eq 0 ] && exit $rc2',
    'exit $rc'
  ].join('; ')
  const r = await withAdmin(script)
  if (r.timedOut) {
    warn('The administrator prompt went unanswered for 2 minutes, so nothing was installed. Click Set up… to try again.')
  } else if (!r.ok && !/User canceled|-128/.test(r.stderr)) {
    warn(`Lid-close setup failed: ${r.stderr.trim() || 'unknown error'}`)
  }
  await checkLidReady()
  push()
  return getAwakeState()
}

/** Remove the rule this app installed. Refused while it is in use. */
export async function removeLidSetup(): Promise<AwakeState> {
  const j = J()
  if (j.session || runtimeDirty(j.runtime)) {
    warn('End the awake session before removing lid-close setup.')
  } else if (existsSync(SUDOERS_FILE)) {
    await withAdmin(`/bin/rm -f ${SUDOERS_FILE}`)
    await checkLidReady()
  }
  push()
  return getAwakeState()
}

// ---------- launchd backstop ----------

const BACKSTOP_SH = `#!/bin/sh
# Awake-session recovery backstop, run by launchd every minute while a
# session (or an unfinished restore) exists. If the app is gone once the
# session should have ended, undo what the journal says the app changed.
J="$1"
LABEL="$2"
PLIST="$3"
get() { /usr/bin/plutil -extract "$1" raw "$J" 2>/dev/null; }
retire() {
  /bin/rm -f "$PLIST"
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$LABEL" >/dev/null 2>&1
  exit 0
}
[ -f "$J" ] || retire

PID=$(get appPid)
if [ -n "$PID" ] && [ "$(echo $(/bin/ps -o lstart= -p "$PID" 2>/dev/null))" = "$(get appStartedAt)" ]; then
  exit 0  # the app is running and owns the session
fi
SID=$(get session.id)
if [ -n "$SID" ]; then
  END=$(get endsAtEpoch)
  [ "$(/bin/date +%s)" -ge "\${END:-0}" ] || exit 0  # a valid session: leave it alone
fi

ok=1
if [ "$(get runtime.sleepDisabledByUs)" = "true" ]; then
  /usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 >/dev/null 2>&1 || ok=0
fi
if [ "$(get runtime.lowPowerByUs)" = "true" ]; then
  /usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0 >/dev/null 2>&1
fi
if [ "$(get runtime.mutedByUs)" = "true" ]; then
  /usr/bin/osascript -e 'set volume without output muted' >/dev/null 2>&1
fi
N=$(get runtime.frozen)
i=0
while [ "$i" -lt "\${N:-0}" ]; do
  P=$(get "runtime.frozen.$i.pid")
  S=$(get "runtime.frozen.$i.startedAt")
  if [ -n "$P" ] && [ "$(echo $(/bin/ps -o lstart= -p "$P" 2>/dev/null))" = "$S" ]; then
    /bin/kill -CONT "$P" 2>/dev/null
  fi
  i=$((i + 1))
done

N=$(get runtime.appNap)
i=0
while [ "$i" -lt "\${N:-0}" ]; do
  ID=$(get "runtime.appNap.$i.bundleId")
  PREV=$(get "runtime.appNap.$i.previous")
  case "$ID" in
    ''|-*|*/*|NSGlobalDomain) ;;
    *)
      if [ "$PREV" = "true" ]; then /usr/bin/defaults write "$ID" NSAppSleepDisabled -bool YES || ok=0
      elif [ "$PREV" = "false" ]; then /usr/bin/defaults write "$ID" NSAppSleepDisabled -bool NO || ok=0
      else /usr/bin/defaults delete "$ID" NSAppSleepDisabled >/dev/null 2>&1
      fi ;;
  esac
  i=$((i + 1))
done

[ "$ok" = 1 ] || exit 1
printf '%s\\n' '{"version":1,"session":null,"mode":null,"endsAtEpoch":0,"appPid":0,"appStartedAt":"","runtime":{"sleepDisabledByUs":false,"lowPowerByUs":false,"mutedByUs":false,"frozen":[],"appNap":[]}}' > "$J.tmp" && /bin/mv "$J.tmp" "$J"
retire
`

const plistPath = (): string => join(homedir(), 'Library', 'LaunchAgents', `${BACKSTOP_LABEL}.plist`)

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function armBackstop(): Promise<void> {
  const script = join(dir, 'backstop.sh')
  await writeFile(script, BACKSTOP_SH, { mode: 0o700 })
  await chmod(script, 0o700)
  const args = ['/bin/sh', script, journalPath, BACKSTOP_LABEL, plistPath()]
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BACKSTOP_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(plistPath(), plist, { mode: 0o644 })
  const uid = String(process.getuid?.() ?? userInfo().uid)
  const loaded = await run('/bin/launchctl', ['print', `gui/${uid}/${BACKSTOP_LABEL}`], 5000)
  if (!loaded.ok) {
    const r = await run('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath()], 10_000)
    if (!r.ok) warn('The crash-recovery backstop could not be armed; keep the app open until the session ends.')
  }
}

async function disarmBackstop(): Promise<void> {
  const uid = String(process.getuid?.() ?? userInfo().uid)
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${BACKSTOP_LABEL}`], 10_000)
  await rm(plistPath(), { force: true })
}

// ---------- lid-close actions ----------

async function freezeApps(config: AwakeConfig): Promise<void> {
  if (config.freezeList.length === 0) return
  const procs = await listProcesses()
  for (const bundleId of config.freezeList) {
    if (bundleId.startsWith('com.apple.') || FREEZE_DENYLIST.has(bundleId)) continue
    const path = await bundlePath(bundleId)
    if (!path) continue
    // The whole bundle: main process plus every helper inside it.
    const targets = procs.filter(
      (p) =>
        p.command.startsWith(path + '/') &&
        p.pid !== process.pid &&
        !p.stat.startsWith('T') && // already stopped by someone else — not ours to claim
        !J().runtime.frozen.some((f) => f.pid === p.pid)
    )
    if (targets.length === 0) continue
    const entries = targets.map((p) => ({ pid: p.pid, startedAt: p.startedAt, bundleId }))
    const j = J()
    try {
      await writeJournal({ ...j, runtime: { ...j.runtime, frozen: [...j.runtime.frozen, ...entries] } })
    } catch {
      warn(`Couldn't record the freeze for ${basename(path, '.app')}, so it was left running.`)
      continue
    }
    const stopped: FrozenProcess[] = []
    for (const e of entries) {
      try {
        process.kill(e.pid, 'SIGSTOP')
        stopped.push(e)
      } catch {
        // Exited between the listing and the signal.
      }
    }
    // Drop the pids that exited before the signal; keep everything stopped.
    const missed = new Set(entries.filter((e) => !stopped.includes(e)).map((e) => e.pid))
    const k = J()
    await writeJournal({
      ...k,
      runtime: { ...k.runtime, frozen: k.runtime.frozen.filter((f) => !missed.has(f.pid)) }
    }).catch(() => undefined)
  }
}

/** Resume only processes whose start time still matches what was frozen. */
async function resumeFrozen(): Promise<void> {
  const j = J()
  if (j.runtime.frozen.length === 0) return
  for (const f of j.runtime.frozen) {
    if ((await processStart(f.pid)) === f.startedAt) {
      try {
        process.kill(f.pid, 'SIGCONT')
      } catch {
        // Gone already.
      }
    }
  }
  const k = J()
  await writeJournal({ ...k, runtime: { ...k.runtime, frozen: [] } })
}

async function muteForLid(): Promise<void> {
  if (J().runtime.mutedByUs) return
  if ((await isMuted()) !== false) return // already muted (or unreadable): not ours
  const j = J()
  await writeJournal({ ...j, runtime: { ...j.runtime, mutedByUs: true } })
  if (!(await setMuted(true))) {
    const k = J()
    await writeJournal({ ...k, runtime: { ...k.runtime, mutedByUs: false } })
  }
}

async function unmute(): Promise<void> {
  if (!J().runtime.mutedByUs) return
  // Only unmute if it is still muted — the user may have changed it meanwhile.
  if ((await isMuted()) === true && !(await setMuted(false))) {
    warn('Audio was muted on lid close and could not be unmuted.')
    return
  }
  const j = J()
  await writeJournal({ ...j, runtime: { ...j.runtime, mutedByUs: false } })
}

async function onLidClosed(): Promise<void> {
  // Without the sleep hold, closing the lid sleeps the Mac regardless, so
  // muting or freezing on the way down only leaves things to undo on wake.
  // (The lid-simulation test hook exercises them in either mode.)
  if (J().mode !== 'lid' && !process.env.ACC_SIMULATE_LID) return
  const config = getAwakeConfig()
  if (config.muteOnLidClose) await muteForLid().catch(() => undefined)
  await freezeApps(config).catch(() => undefined)
  await evaluateFloors()
  // Best effort: with sleep disabled macOS no longer turns the panel off on
  // close, and a display assertion held by another app can veto this.
  if (config.darkenDisplayOnLidClose) await run(PMSET, ['displaysleepnow'], 5000)
}

async function onLidOpened(): Promise<void> {
  await resumeFrozen().catch(() => warn('Some frozen apps could not be resumed.'))
  await unmute().catch(() => undefined)
  await evaluateFloors()
}

// ---------- battery / heat floors ----------

async function setLowPower(on: boolean): Promise<void> {
  const j = J()
  if (on) {
    if (j.runtime.lowPowerByUs || !live.lidReady) return
    if ((await isLowPowerOn()) !== false) return // already on, or unreadable: never claim it
    await writeJournal({ ...j, runtime: { ...j.runtime, lowPowerByUs: true } })
    const r = await sudoPmset(['-b', 'lowpowermode', '1'])
    if (!r.ok) {
      const k = J()
      await writeJournal({ ...k, runtime: { ...k.runtime, lowPowerByUs: false } })
    }
  } else if (j.runtime.lowPowerByUs) {
    const r = await sudoPmset(['-b', 'lowpowermode', '0'])
    if (!r.ok) {
      warn('Low Power Mode could not be switched back off.')
      return
    }
    const k = J()
    await writeJournal({ ...k, runtime: { ...k.runtime, lowPowerByUs: false } })
  }
}

/** Battery / thermal / lid rules. Ends the session or toggles Low Power Mode. */
async function evaluateFloors(): Promise<void> {
  if (!J().session) return
  const c = getAwakeConfig()
  const pct = live.batteryPercent
  if (c.thermalRules && live.thermal === 'critical') {
    await endNow('thermal')
    return
  }
  if (live.onBattery && c.endFloor > 0 && pct !== null && pct < c.endFloor) {
    await endNow('battery')
    return
  }
  const want =
    (live.lidClosed && !live.clamshell && c.lowPowerOnLidClose) ||
    (live.onBattery && pct !== null && pct < c.lowPowerFloor) ||
    (c.thermalRules && live.thermal === 'serious')
  await setLowPower(want).catch(() => undefined)
}

// ---------- App Nap ----------

/** Agent apps App Nap must not throttle mid-session (Insomnia's list). */
const AGENT_APPS = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'com.microsoft.VSCode',
  'com.todesktop.230313mzl4w4u92', // Cursor
  'dev.zed.Zed',
  'com.google.antigravity',
  'com.anthropic.claudefordesktop',
  'com.openai.codex',
  'com.t3tools.t3code',
  'com.conductor.app',
  'com.google.Chrome',
  'org.chromium.Chromium',
  'company.thebrowser.Browser',
  'com.docker.docker',
  'io.tailscale.ipn.macsys',
  'ai.elementlabs.lmstudio',
  'com.electron.ollama'
]

/** Only plain bundle ids — never NSGlobalDomain, a path, or a flag. */
const safeDomain = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== 'NSGlobalDomain'

function agentApps(): string[] {
  // Test hook: ACC_APPNAP_APPS replaces the list with stand-in ids.
  const override = process.env.ACC_APPNAP_APPS
  return override ? override.split(',').map((s) => s.trim()).filter(Boolean) : AGENT_APPS
}

async function readSleepDisabled(id: string): Promise<boolean | null | 'error'> {
  const r = await run('/usr/bin/defaults', ['read', id, 'NSAppSleepDisabled'], 5000)
  if (r.ok) return r.stdout.trim() === '1'
  return /does not exist/.test(r.stderr) ? null : 'error'
}

async function writeSleepDisabled(id: string, value: boolean | null): Promise<boolean> {
  const args =
    value === null
      ? ['delete', id, 'NSAppSleepDisabled']
      : ['write', id, 'NSAppSleepDisabled', '-bool', value ? 'YES' : 'NO']
  return (await run('/usr/bin/defaults', args, 5000)).ok
}

/** Turn App Nap off for each installed agent app, journaling the previous
 *  value first. Apps already set to YES are skipped — nothing to put back. */
async function holdAppNap(): Promise<void> {
  for (const id of agentApps()) {
    if (!safeDomain(id) || J().runtime.appNap.some((o) => o.bundleId === id)) continue
    const path = await bundlePath(id)
    if (!path) continue // not installed: never create a preferences domain for it
    appNapNames[id] = basename(path, '.app')
    const previous = await readSleepDisabled(id)
    if (previous === 'error' || previous === true) continue
    try {
      await writeJournal({ ...J(), runtime: { ...J().runtime, appNap: [...J().runtime.appNap, { bundleId: id, previous }] } })
    } catch {
      continue // unrecorded changes are never made
    }
    if (!(await writeSleepDisabled(id, true))) {
      await writeJournal({
        ...J(),
        runtime: { ...J().runtime, appNap: J().runtime.appNap.filter((o) => o.bundleId !== id) }
      }).catch(() => undefined)
    }
  }
}

/** Put each recorded value back; an entry is cleared only once that worked. */
async function releaseAppNap(): Promise<boolean> {
  let ok = true
  for (const o of [...J().runtime.appNap]) {
    if (await writeSleepDisabled(o.bundleId, o.previous)) {
      await writeJournal({
        ...J(),
        runtime: { ...J().runtime, appNap: J().runtime.appNap.filter((x) => x.bundleId !== o.bundleId) }
      })
    } else {
      ok = false
    }
  }
  if (!ok) warn("Some apps' App Nap settings couldn't be put back; the next session end or launch retries.")
  return ok
}

// ---------- browser throttling ----------

async function rescanBrowsers(): Promise<void> {
  const found = await scanThrottledBrowsers().catch(() => live.throttledBrowsers)
  const changed = JSON.stringify(found) !== JSON.stringify(live.throttledBrowsers)
  live.throttledBrowsers = found
  if (changed) push()
}

/** Quit and reopen a browser with the unthrottling flags (the popover has
 *  already asked). Anything that stopped it shows as a warning. */
export async function relaunchBrowser(bundleId: string): Promise<AwakeState> {
  const problem = await relaunchUnthrottled(bundleId)
  if (problem) warn(problem)
  await rescanBrowsers()
  push()
  return getAwakeState()
}

// ---------- network outage → tmux nudge ----------

async function isOnline(): Promise<boolean> {
  // Test hook: `echo offline > $ACC_SIMULATE_OFFLINE` simulates an outage.
  const simulated = process.env.ACC_SIMULATE_OFFLINE
  if (simulated) {
    try {
      return (await readFile(simulated, 'utf8')).trim() !== 'offline'
    } catch {
      return true
    }
  }
  return net.isOnline()
}

/** Track outages during a session; when the network returns after 90 s or
 *  more, nudge marked tmux panes (if enabled) so stalled agents retry. */
async function pollNetwork(): Promise<void> {
  const s = J().session
  if (!s) return
  const online = await isOnline()
  if (!online) {
    if (live.offlineSince === null) {
      live.offlineSince = Date.now()
      push()
    }
    return
  }
  if (live.offlineSince === null) return
  const gap = Date.now() - live.offlineSince
  live.offlineSince = null
  push()
  const c = getAwakeConfig()
  if (gap < NUDGE_AFTER_MS || !c.tmuxNudge) return
  const sid = s.id
  const n = await nudgeMarkedPanes(c.tmuxNudgePressesEnter, () => J().session?.id === sid)
  if (n > 0) {
    notify(
      'Network back — agents nudged',
      `Typed "continue" into ${n} tmux pane${n === 1 ? '' : 's'} after ${Math.round(gap / 60_000)} min offline.`
    )
  }
}

// ---------- monitors ----------

function startMonitors(): void {
  stopMonitors()
  lidTimer = setInterval(() => {
    void readLid().then(({ closed, clamshell, away }) => {
      const wasAway = live.lidClosed && !live.clamshell
      if (closed === live.lidClosed && clamshell === live.clamshell) return
      live.lidClosed = closed
      live.clamshell = clamshell
      void exclusive(async () => {
        if (!J().session) return
        // Plugging in or unplugging an external display with the lid shut
        // flips between "in use" and "away" just like opening the lid.
        if (away && !wasAway) await onLidClosed()
        else if (!away && wasAway) await onLidOpened()
        push()
      })
    })
  }, 2000)
  netTimer = setInterval(() => void pollNetwork(), 5000)
  // ACC_FLOOR_POLL_MS shortens the battery/heat poll for tests (default 60 s).
  const floorPollMs = Number(process.env.ACC_FLOOR_POLL_MS) || 60_000
  batteryTimer = setInterval(() => {
    void pollBattery()
    void rescanBrowsers()
    // Keep the "agents working" tag fresh while the agent rule is on.
    if (getAwakeConfig().extendWhileAgentsWork) {
      void countWorkingAgents().then((n) => {
        if (n !== live.agentsWorking) {
          live.agentsWorking = n
          push()
        }
      })
    }
  }, floorPollMs)
  // Belt and braces next to the exact end timer: a sleeping or suspended
  // process can overshoot setTimeout, so check the deadline regularly too.
  tickTimer = setInterval(() => {
    const s = J().session
    if (s && Date.now() >= new Date(s.endsAt).getTime()) void expire()
  }, 15_000)
  armEndTimer()
}

function stopMonitors(): void {
  for (const t of [lidTimer, batteryTimer, tickTimer, netTimer]) if (t) clearInterval(t)
  if (endTimer) clearTimeout(endTimer)
  lidTimer = batteryTimer = tickTimer = endTimer = netTimer = null
  live.offlineSince = null
}

function armEndTimer(): void {
  if (endTimer) clearTimeout(endTimer)
  const s = J().session
  if (!s) return
  const ms = Math.max(0, new Date(s.endsAt).getTime() - Date.now())
  // setTimeout caps at ~24.8 days; the tick timer covers anything longer.
  endTimer = setTimeout(() => void expire(), Math.min(ms, 2_000_000_000))
}

/** Test hook: ACC_SIMULATE_THERMAL=<file> holding nominal / fair / serious / critical. */
async function readSimulatedThermal(): Promise<AwakeState['thermal'] | null> {
  const simulated = process.env.ACC_SIMULATE_THERMAL
  if (!simulated) return null
  try {
    const s = (await readFile(simulated, 'utf8')).trim()
    return s === 'nominal' || s === 'fair' || s === 'serious' || s === 'critical' ? s : null
  } catch {
    return null
  }
}

async function pollBattery(): Promise<void> {
  const b = await readBattery()
  const thermal = await readSimulatedThermal()
  const thermalChanged = thermal !== null && thermal !== live.thermal
  if (thermal !== null) live.thermal = thermal
  const changed =
    thermalChanged || b.onBattery !== live.onBattery || b.percent !== live.batteryPercent
  live.onBattery = b.onBattery
  live.batteryPercent = b.percent
  if (changed && J().session) {
    await exclusive(evaluateFloors)
    push()
  }
}

// ---------- session lifecycle ----------

function holdAssertion(): void {
  if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  }
}

function releaseAssertion(): void {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = null
}

export function startSession(seconds: number, auto = false): Promise<AwakeState> {
  return exclusive(async () => {
    if (J().session) return extendNow(seconds)
    if (runtimeDirty(J().runtime)) await restore()
    clearWarnings()
    // Don't start a session the floors would end a moment later — say why instead.
    const b0 = await readBattery()
    live.onBattery = b0.onBattery
    live.batteryPercent = b0.percent
    const t0 = await readSimulatedThermal()
    if (t0) live.thermal = t0
    const floors = getAwakeConfig()
    if (floors.thermalRules && live.thermal === 'critical') {
      warn("The Mac is at critical heat, so no session was started. Let it cool down first.")
      push()
      return getAwakeState()
    }
    if (b0.onBattery && floors.endFloor > 0 && b0.percent !== null && b0.percent < floors.endFloor) {
      warn(
        `Battery is at ${b0.percent}%, below the ${floors.endFloor}% end limit, so no session was started. Plug in, or lower the limit under ⚙.`
      )
      push()
      return getAwakeState()
    }
    const secs = Math.round(Math.min(MAX_SESSION_S, Math.max(MIN_SESSION_S, seconds)))
    const now = Date.now()
    const session: AwakeSession = {
      id: randomUUID(),
      startedAt: new Date(now).toISOString(),
      endsAt: new Date(now + secs * 1000).toISOString(),
      extendedBy: [],
      ...(auto ? { auto: true } : {})
    }
    await checkLidReady()
    let mode: AwakeMode = live.lidReady ? 'lid' : 'assertion'
    try {
      await writeJournal({
        ...emptyJournal(),
        session,
        mode,
        endsAtEpoch: Math.floor(new Date(session.endsAt).getTime() / 1000)
      })
    } catch (err) {
      warn(`Couldn't write the session journal, so nothing was changed: ${String(err)}`)
      return getAwakeState()
    }

    holdAssertion()
    live.foreignSleepHold = false

    if (mode === 'lid') {
      if (await isSleepDisabled()) {
        // Someone else already holds it: use it, but never claim (or undo) it.
        live.foreignSleepHold = true
      } else {
        await writeJournal({ ...J(), runtime: { ...J().runtime, sleepDisabledByUs: true } })
        const r = await sudoPmset(['-a', 'disablesleep', '1'])
        // macOS can quietly flip the bit back; confirm it held.
        let held = false
        if (r.ok) {
          await new Promise((res) => setTimeout(res, 1200))
          held = await isSleepDisabled()
        }
        if (!held) {
          if (r.ok) await sudoPmset(['-a', 'disablesleep', '0'])
          await writeJournal({
            ...J(),
            mode: 'assertion',
            runtime: { ...J().runtime, sleepDisabledByUs: false }
          })
          mode = 'assertion'
          warn("Lid-close sleep couldn't be turned off, so this session only holds while the lid is open.")
        }
      }
    }

    await armBackstop().catch(() =>
      warn('The crash-recovery backstop could not be armed; keep the app open until the session ends.')
    )
    if (getAwakeConfig().disableAppNapForAgents) await holdAppNap().catch(() => undefined)
    const lid = await readLid()
    live.lidClosed = lid.closed
    live.clamshell = lid.clamshell
    const b = await readBattery()
    live.onBattery = b.onBattery
    live.batteryPercent = b.percent
    startMonitors()
    if (lid.away) await onLidClosed()
    else await evaluateFloors()
    push()
    return getAwakeState()
  })
}

async function extendNow(seconds: number): Promise<AwakeState> {
  const j = J()
  if (!j.session) return getAwakeState()
  const now = Date.now()
  const base = Math.max(now, new Date(j.session.endsAt).getTime())
  const endsAt = Math.min(base + Math.max(0, seconds) * 1000, now + MAX_SESSION_S * 1000)
  const added = Math.round((endsAt - new Date(j.session.endsAt).getTime()) / 1000)
  if (added <= 0) return getAwakeState()
  const session = {
    ...j.session,
    endsAt: new Date(endsAt).toISOString(),
    extendedBy: [...j.session.extendedBy, added]
  }
  await writeJournal({ ...j, session, endsAtEpoch: Math.floor(endsAt / 1000) })
  armEndTimer()
  push()
  return getAwakeState()
}

/** Claude sessions currently mid-turn, from the terminals panel's snapshot. */
async function countWorkingAgents(): Promise<number> {
  try {
    const snap = await getTerminals(listRepos())
    return (
      snap.entries.filter((e) => e.agent?.state === 'working').length +
      snap.unbound.filter((u) => u.state === 'working').length
    )
  } catch {
    return 0
  }
}

/** The timer ran out. With "stay awake while agents work" on and a Claude
 *  session still mid-turn, add 15 minutes (bounded at 12 hours in total) —
 *  otherwise end. Re-checks the deadline, since an extend may have landed. */
function expire(): Promise<AwakeState> {
  return exclusive(async () => {
    const s = J().session
    if (!s || Date.now() < new Date(s.endsAt).getTime()) return getAwakeState()
    const auto = (s.autoExtendedBy ?? []).reduce((a, b) => a + b, 0)
    // An auto-started session exists for the agents, so it always follows them.
    if ((getAwakeConfig().extendWhileAgentsWork || s.auto) && auto < AGENT_CAP_S) {
      live.agentsWorking = await countWorkingAgents()
      if (live.agentsWorking > 0) {
        const step = Math.min(AGENT_STEP_S, AGENT_CAP_S - auto)
        const endsAt = Date.now() + step * 1000
        const session = {
          ...s,
          endsAt: new Date(endsAt).toISOString(),
          autoExtendedBy: [...(s.autoExtendedBy ?? []), step]
        }
        await writeJournal({ ...J(), session, endsAtEpoch: Math.floor(endsAt / 1000) })
        armEndTimer()
        if (auto === 0) {
          notify(
            'Staying awake — agents still working',
            `${live.agentsWorking} Claude session${live.agentsWorking === 1 ? ' is' : 's are'} mid-turn, so the session keeps going 15 minutes at a time.`
          )
        }
        push()
        return getAwakeState()
      }
    }
    return endNow('expired')
  })
}

export function extendSession(seconds: number): Promise<AwakeState> {
  return exclusive(() => extendNow(seconds))
}

/** Undo everything the journal says this app changed. Leaves an entry in
 *  place (and a warning up) for anything that could not be restored. */
async function restore(): Promise<boolean> {
  let complete = true
  await resumeFrozen().catch(() => {
    complete = false
    warn('Some frozen apps could not be resumed.')
  })
  await unmute().catch(() => undefined)
  if (J().runtime.mutedByUs) complete = false
  if (J().runtime.appNap.length > 0 && !(await releaseAppNap().catch(() => false))) complete = false
  if (J().runtime.lowPowerByUs) {
    await setLowPower(false).catch(() => undefined)
    if (J().runtime.lowPowerByUs) complete = false
  }
  if (J().runtime.sleepDisabledByUs) {
    const r = await sudoPmset(['-a', 'disablesleep', '0'])
    if (r.ok && !(await isSleepDisabled())) {
      await writeJournal({ ...J(), runtime: { ...J().runtime, sleepDisabledByUs: false } })
    } else {
      complete = false
      warn(
        'Sleep could not be turned back on. Run "sudo pmset -a disablesleep 0" in Terminal, or retry from the awake panel.'
      )
    }
  }
  return complete
}

export function endSession(reason: AwakeEndReason): Promise<AwakeState> {
  return exclusive(() => endNow(reason))
}

/** End without queueing — for callers already inside `exclusive`. */
async function endNow(reason: AwakeEndReason): Promise<AwakeState> {
  const had = J().session
  stopMonitors()
  releaseAssertion()
  if (had) await writeJournal({ ...J(), session: null, mode: null, endsAtEpoch: 0 }).catch(() => undefined)
  const complete = await restore()
  if (complete) await disarmBackstop().catch(() => undefined)
  live.foreignSleepHold = false
  // Ended by hand: don't auto-start again until the agents have gone idle.
  if (had && reason === 'user') autoSuppressed = true
  if (had) {
    live.lastEnd = { at: new Date().toISOString(), reason }
    const why: Record<AwakeEndReason, string> = {
      expired: 'The timer ran out.',
      user: 'Ended early.',
      battery: `Battery fell below ${getAwakeConfig().endFloor}%.`,
      thermal: 'The Mac reached critical heat.',
      quit: 'The app quit.',
      recovered: 'Recovered after the app restarted.'
    }
    if (reason !== 'user' && reason !== 'quit') {
      notify(
        complete ? 'Awake session ended' : 'Awake session ended — restore incomplete',
        complete ? `${why[reason]} Your Mac can sleep again.` : 'Open the command center to finish restoring.'
      )
    }
  }
  push()
  return getAwakeState()
}

// ---------- agent watcher (auto-start) ----------

let autoSuppressed = false

/** With "start automatically when agents work" on and no session running,
 *  start a 30-minute session once a Claude session is working; it then
 *  extends while they keep working. Ending it by hand stands until every
 *  agent has gone idle, so the watcher never fights the user. */
async function autoStartTick(): Promise<void> {
  if (!getAwakeConfig().autoStartWithAgents) {
    autoSuppressed = false
    return
  }
  const n = await countWorkingAgents()
  if (n === 0) {
    autoSuppressed = false
    return
  }
  if (autoSuppressed || J().session || runtimeDirty(J().runtime)) return
  live.agentsWorking = n
  await startSession(AUTO_START_S, true)
  if (J().session) {
    notify(
      'Keeping your Mac awake',
      `${n} Claude session${n === 1 ? ' is' : 's are'} working — awake until they finish (up to 12 hours).`
    )
  }
}

export function dismissAwakeWarnings(): AwakeState {
  clearWarnings()
  live.lastEnd = null
  push()
  return getAwakeState()
}

export function retryRestore(): Promise<AwakeState> {
  return exclusive(async () => {
    clearWarnings()
    if (await restore()) await disarmBackstop().catch(() => undefined)
    push()
    return getAwakeState()
  })
}

export async function updateAwakeConfig(patch: Partial<AwakeConfig>): Promise<AwakeState> {
  const config = setAwakeConfig(patch)
  await refreshFreezeNames(config)
  if (J().session) await exclusive(evaluateFloors)
  push()
  return getAwakeState()
}

/** Re-read access and battery (the popover calls this as it opens) and push,
 *  so a rule installed from Terminal or a charger plugged in shows at once. */
export async function refreshAwake(): Promise<AwakeState> {
  await checkLidReady()
  const b = await readBattery()
  live.onBattery = b.onBattery
  live.batteryPercent = b.percent
  await rescanBrowsers()
  push()
  return getAwakeState()
}

/** Reconcile the journal at launch: resume a session still in progress, or
 *  undo whatever an earlier run left changed. */
export async function initAwake(): Promise<void> {
  dir = join(app.getPath('userData'), 'awake')
  journalPath = join(dir, 'journal.json')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  appStartedAt = (await processStart(process.pid)) ?? ''
  await refreshFreezeNames(getAwakeConfig())
  await checkLidReady()

  powerMonitor.on('thermal-state-change', (...args: unknown[]) => {
    const details = args.find((a) => a && typeof a === 'object' && 'state' in (a as object)) as
      | { state?: string }
      | undefined
    const s = details?.state
    if (s === 'nominal' || s === 'fair' || s === 'serious' || s === 'critical') live.thermal = s
    if (J().session) void exclusive(evaluateFloors).then(push)
  })
  powerMonitor.on('on-battery', () => void pollBattery())
  powerMonitor.on('on-ac', () => void pollBattery())

  const found = await readJournal()
  journal = found ?? emptyJournal()
  const b = await readBattery()
  live.onBattery = b.onBattery
  live.batteryPercent = b.percent
  const lid = await readLid()
  live.lidClosed = lid.closed
  live.clamshell = lid.clamshell

  const s = journal.session
  if (s && new Date(s.endsAt).getTime() > Date.now()) {
    // The app restarted mid-session: take it over (the journal now names us).
    await writeJournal(journal).catch(() => undefined)
    holdAssertion()
    await armBackstop().catch(() => undefined)
    startMonitors()
    // Not away (lid open, or clamshell in use): undo any lid-close actions.
    if (!lid.away) await exclusive(onLidOpened).catch(() => undefined)
  } else if (s || runtimeDirty(journal.runtime)) {
    await endSession('recovered')
  }

  setInterval(() => void autoStartTick().catch(() => undefined), AUTO_WATCH_MS)

  app.on('before-quit', (e) => {
    if (quitting) return
    const j = J()
    if (!j.session && !runtimeDirty(j.runtime)) return
    // Quit undoes the session first, the same as ending it.
    e.preventDefault()
    quitting = true
    void endSession('quit').finally(() => app.quit())
  })
}
