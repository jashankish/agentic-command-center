import { execFile } from 'child_process'
import { accessSync } from 'fs'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** One row of the system process table. */
export interface PsRow {
  pid: number
  ppid: number
  /** Controlling terminal as ps reports it (e.g. "ttys004"), or null for "??". */
  tty: string | null
  /** BSD state flags — 's' = session leader, '+' = foreground process group. */
  stat: string
  /** %CPU over the sampling interval. */
  pcpu: number
  /** Elapsed seconds since the process started. */
  etimeSec: number
  /** Full command line. */
  args: string
}

// pid ppid tty stat pcpu etime args…  (args is the greedy remainder)
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(.*)$/

/** "ss" | "mm:ss" | "hh:mm:ss" | "d-hh:mm:ss" → seconds. */
function etimeToSec(etime: string): number {
  const [dayPart, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = clock.split(':').map((n) => parseInt(n, 10) || 0)
  while (parts.length < 3) parts.unshift(0)
  return (parseInt(dayPart, 10) || 0) * 86_400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

// The whole panel polls every few seconds; one ps fork serves all callers.
const CACHE_MS = 3000
let cache: { at: number; value: PsRow[] } | null = null
let inflight: Promise<PsRow[]> | null = null

export async function psScan(): Promise<PsRow[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight

  inflight = execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,tty=,stat=,pcpu=,etime=,args='], {
    maxBuffer: 8 * 1024 * 1024
  })
    .then(({ stdout }) => {
      const rows: PsRow[] = []
      for (const line of stdout.split('\n')) {
        const m = PS_LINE.exec(line)
        if (!m) continue
        rows.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          tty: m[3] === '??' ? null : m[3],
          stat: m[4],
          pcpu: Number(m[5]) || 0,
          etimeSec: etimeToSec(m[6]),
          args: m[7]
        })
      }
      cache = { at: Date.now(), value: rows }
      return rows
    })
    .catch(() => [] as PsRow[])
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * True when the row is an interactive Claude Code CLI. Matching is on the
 * executable basename (also behind a node/bun launcher), case-sensitively —
 * the Claude *desktop app* binary is "Claude" and must not match.
 */
export function isClaudeCli(row: PsRow): boolean {
  const tokens = row.args.split(/\s+/)
  const base = (t: string | undefined): string => (t ? t.slice(t.lastIndexOf('/') + 1) : '')
  if (base(tokens[0]) === 'claude') return true
  const launcher = base(tokens[0])
  return (launcher === 'node' || launcher === 'bun') && base(tokens[1]) === 'claude'
}

/**
 * Foreground process of a tty: among the foreground process group ('+' flag),
 * prefer a Claude CLI, else the newest pid (the actual command rather than the
 * login/shell wrappers that share the group).
 */
export function foregroundOf(rows: PsRow[], tty: string): PsRow | null {
  const fg = rows.filter((r) => r.tty === tty && r.stat.includes('+'))
  if (fg.length === 0) return null
  return fg.find(isClaudeCli) ?? fg.reduce((a, b) => (b.pid > a.pid ? b : a))
}

/** True when any live descendant of `rootPid` looks like an executing tool
 *  (runnable, consuming CPU, or recently started) — long-idle children such as
 *  MCP servers don't count. */
export function hasActiveDescendant(rows: PsRow[], rootPid: number): boolean {
  const children = new Map<number, PsRow[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r)
    else children.set(r.ppid, [r])
  }
  const stack = [...(children.get(rootPid) ?? [])]
  while (stack.length) {
    const r = stack.pop()!
    if (!r.stat.startsWith('Z')) {
      if (/[RU]/.test(r.stat) || r.pcpu >= 1 || r.etimeSec < 120) return true
      const kids = children.get(r.pid)
      if (kids) stack.push(...kids)
    }
  }
  return false
}

/**
 * Best-effort label of the app hosting a tty, walked up from the tty's session
 * leader. Lets sessions in terminals we can't enumerate (tmux, IDE panes) at
 * least name their host.
 */
export function ttyHostApp(rows: PsRow[], tty: string): string | null {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const leader = rows.find((r) => r.tty === tty && r.stat.includes('s'))
  let p = leader ? byPid.get(leader.ppid) : undefined
  for (let hop = 0; p && hop < 5; hop++) {
    if (/iTermServer|iTerm\.app/.test(p.args)) return 'iTerm2'
    if (/Terminal\.app\/Contents\/MacOS\/Terminal/.test(p.args)) return 'Terminal'
    if (/Cursor.*pty-host|Cursor Helper/.test(p.args)) return 'Cursor'
    if (/Code Helper|VS Code.*pty-host/.test(p.args)) return 'VS Code'
    if (/(^|\/)tmux/.test(p.args)) return 'tmux'
    if (/Ghostty/i.test(p.args)) return 'Ghostty'
    p = byPid.get(p.ppid)
  }
  return null
}

function resolveLsof(): string {
  for (const c of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return 'lsof'
}

const lsofBin = resolveLsof()
const CWD_CACHE_MS = 30_000
const cwdCache = new Map<number, { at: number; cwd: string | null }>()

/** Working directory of a process (cached — cwds rarely change mid-session). */
export async function cwdOfPid(pid: number): Promise<string | null> {
  const hit = cwdCache.get(pid)
  if (hit && Date.now() - hit.at < CWD_CACHE_MS) return hit.cwd
  let cwd: string | null = null
  try {
    const { stdout } = await execFileAsync(lsofBin, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    cwd = line ? line.slice(1) : null
  } catch {
    cwd = null
  }
  // Evict stale pids so the map can't grow unbounded across process churn.
  if (cwdCache.size > 512) cwdCache.clear()
  cwdCache.set(pid, { at: Date.now(), cwd })
  return cwd
}
