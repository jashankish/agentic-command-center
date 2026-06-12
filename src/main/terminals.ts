import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  AutomationState,
  CommitPushResult,
  FocusTarget,
  TerminalEntry,
  TerminalsSnapshot,
  UnboundSession
} from '../shared/types'
import { getAgentSessions } from './agentsessions'
import { foregroundOf, cwdOfPid, psScan, ttyHostApp } from './procs'
import { redactError } from './redact'

/**
 * Terminal topology + process join (plan §3, layers L1+L2).
 *
 * One osascript per running terminal app enumerates every window/tab with its
 * tty; one ps pass identifies each tty's foreground process; lsof maps the
 * interesting pids to working directories; agentsessions.ts contributes the
 * Claude state per tty. Everything is read-only and local. Each layer degrades
 * alone: no Automation consent only hides that app's tabs — Claude sessions
 * still surface via the process table as "unbound" entries.
 */

const execFileAsync = promisify(execFile)
const OSA = '/usr/bin/osascript'
const OSA_TIMEOUT_MS = 5_000
const SEP = '|||'

// The terminals panel polls every ~5s and the main window every ~15s; one
// enumeration serves both.
const CACHE_MS = 4_000
let cache: { at: number; key: string; value: TerminalsSnapshot } | null = null
let inflight: Promise<TerminalsSnapshot> | null = null

// Tab/session fields are joined with ||| (same trick as calendar.ts); a
// counter tracks tab order because Terminal.app tabs don't expose an index.
const TERMINAL_ENUM = `set out to ""
tell application "Terminal"
  repeat with w in windows
    set tabIdx to 0
    repeat with t in tabs of w
      set tabIdx to tabIdx + 1
      set ttyName to ""
      try
        set ttyName to tty of t
      end try
      set titleText to ""
      try
        set titleText to custom title of t
      end try
      set out to out & (id of w) & "${SEP}" & tabIdx & "${SEP}" & ttyName & "${SEP}" & (busy of t) & "${SEP}" & titleText & linefeed
    end repeat
  end repeat
end tell
return out`

const ITERM_ENUM = `set out to ""
tell application "iTerm2"
  repeat with w in windows
    set tabIdx to 0
    repeat with t in tabs of w
      set tabIdx to tabIdx + 1
      repeat with s in sessions of t
        set out to out & (id of w) & "${SEP}" & tabIdx & "${SEP}" & (tty of s) & "${SEP}" & (is processing of s) & "${SEP}" & (name of s) & linefeed
      end repeat
    end repeat
  end repeat
end tell
return out`

interface RawSurface {
  windowId: number
  tabIndex: number
  tty: string | null
  busy: boolean
  title: string
}

/** "/dev/ttys004" / "ttys004" → "ttys004" (ps's notation, our join key). */
function normalizeTty(raw: string): string | null {
  const t = raw.trim().replace(/^\/dev\//, '')
  return /^tty[\w]+$/.test(t) ? t : null
}

function parseEnum(stdout: string): RawSurface[] {
  const out: RawSurface[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split(SEP)
    if (parts.length < 5) continue
    const [winId, tabIdx, tty, busy, ...title] = parts
    out.push({
      windowId: Number(winId) || 0,
      tabIndex: Number(tabIdx) || 0,
      tty: normalizeTty(tty ?? ''),
      busy: /true/i.test(busy ?? ''),
      title: title.join(SEP).trim()
    })
  }
  return out
}

interface EnumResult {
  state: AutomationState
  surfaces: RawSurface[]
  error?: string
}

async function enumerate(script: string): Promise<EnumResult> {
  try {
    const { stdout } = await execFileAsync(OSA, ['-e', script], {
      timeout: OSA_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    })
    return { state: 'ok', surfaces: parseEnum(stdout) }
  } catch (err) {
    // -1743 = the user declined the Automation prompt for this app.
    const text = String((err as { stderr?: string })?.stderr ?? err)
    const denied = /-1743|not authori[sz]ed|not allowed/i.test(text)
    return { state: 'denied', surfaces: [], error: denied ? undefined : redactError(err) }
  }
}

/** Strip the path and login-shell dash: "/bin/zsh -il" → "zsh". */
function humanCommand(args: string): string {
  const tokens = args.trim().split(/\s+/)
  let base = (tokens[0] ?? '').slice((tokens[0] ?? '').lastIndexOf('/') + 1)
  if (base.startsWith('-')) base = base.slice(1)
  const text = [base, ...tokens.slice(1).filter((t) => !/^-(il?|l)$/.test(t))].join(' ')
  return text.length > 48 ? text.slice(0, 47) + '…' : text
}

function repoOf(repoPaths: string[], cwd: string | null): string | null {
  if (!cwd) return null
  return repoPaths.find((r) => cwd === r || cwd.startsWith(r + '/')) ?? null
}

async function compute(repoPaths: string[]): Promise<TerminalsSnapshot> {
  const rows = await psScan()

  // Never AppleScript an app that isn't running — that would launch it.
  const terminalRunning = rows.some((r) => r.args.includes('.app/Contents/MacOS/Terminal'))
  const itermRunning = rows.some((r) => r.args.includes('.app/Contents/MacOS/iTerm2'))

  const notRunning: EnumResult = { state: 'not-running', surfaces: [] }
  const [term, iterm, sessions] = await Promise.all([
    terminalRunning ? enumerate(TERMINAL_ENUM) : Promise.resolve(notRunning),
    itermRunning ? enumerate(ITERM_ENUM) : Promise.resolve(notRunning),
    getAgentSessions(rows, repoPaths)
  ])

  const sessionByTty = new Map(sessions.filter((s) => s.tty).map((s) => [s.tty!, s]))
  const boundTtys = new Set<string>()

  // Claude Code prefixes its terminal title with a Braille spinner frame while
  // actively working ("⠐ …") and "✳" once it's idle at the prompt. The title
  // is *per tab*, so it disambiguates two sessions sharing one project dir,
  // where the transcript-derived state is project-level: trust the glyph when
  // it contradicts the inference (never overriding a permission state).
  const SPINNER = /^[⠀-⣿]/

  const toEntry = async (app: TerminalEntry['app'], raw: RawSurface): Promise<TerminalEntry> => {
    const fg = raw.tty ? foregroundOf(rows, raw.tty) : null
    const cwd = fg ? await cwdOfPid(fg.pid) : null
    let agent = raw.tty ? (sessionByTty.get(raw.tty) ?? null) : null
    if (agent && SPINNER.test(raw.title)) {
      agent = { ...agent, state: 'working' }
    } else if (agent?.state === 'working' && raw.title.startsWith('✳')) {
      agent = { ...agent, state: 'input' }
    }
    if (raw.tty && agent) boundTtys.add(raw.tty)
    return {
      app,
      windowId: raw.windowId,
      tabIndex: raw.tabIndex,
      tty: raw.tty,
      title: raw.title,
      command: fg ? humanCommand(fg.args) : null,
      cwd,
      repoPath: repoOf(repoPaths, agent?.cwd ?? cwd),
      busy: raw.busy,
      agent
    }
  }

  const entries = await Promise.all([
    ...term.surfaces.map((s) => toEntry('Terminal', s)),
    ...iterm.surfaces.map((s) => toEntry('iTerm2', s))
  ])

  // Sessions in terminals we couldn't enumerate (tmux, IDE panes, consent
  // denied): still shown, labeled with the hosting app when derivable.
  const unbound: UnboundSession[] = sessions
    .filter((s) => !s.tty || !boundTtys.has(s.tty))
    .map((s) => ({ ...s, host: s.tty ? (ttyHostApp(rows, s.tty) ?? undefined) : undefined }))

  return {
    entries,
    unbound,
    automation: { terminal: term.state, iterm: iterm.state },
    error: term.error ?? iterm.error
  }
}

export async function getTerminals(repoPaths: string[]): Promise<TerminalsSnapshot> {
  const key = [...repoPaths].sort().join('\n')
  const now = Date.now()
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight

  inflight = compute(repoPaths)
    .then((value) => {
      cache = { at: Date.now(), key, value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// Focus scripts match the target by tty equality — stable across tab
// re-ordering, and the same key both apps expose.
function focusScript(target: FocusTarget): string {
  const dev = `/dev/${target.tty}`
  if (target.app === 'iTerm2') {
    return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${dev}" then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "notfound"`
  }
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      set ttyName to ""
      try
        set ttyName to tty of t
      end try
      if ttyName is "${dev}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "notfound"`
}

/** Bring the window/tab owning a tty to the front. UI focus only — nothing else. */
export async function focusTerminal(target: FocusTarget): Promise<CommitPushResult> {
  // The tty is interpolated into AppleScript — accept only the exact shape ps
  // reports (defense against injection, like runScript's script-name guard).
  if (
    (target.app !== 'Terminal' && target.app !== 'iTerm2') ||
    !/^ttys\d{1,5}$/.test(target.tty)
  ) {
    return { success: false, error: 'Invalid focus target.' }
  }
  try {
    const { stdout } = await execFileAsync(OSA, ['-e', focusScript(target)], {
      timeout: OSA_TIMEOUT_MS
    })
    if (stdout.trim() === 'ok') return { success: true }
    return { success: false, error: 'That terminal tab is gone.' }
  } catch (err) {
    return { success: false, error: redactError(err) }
  }
}
