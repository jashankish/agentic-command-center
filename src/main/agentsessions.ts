import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentSessionState, AgentState } from '../shared/types'
import { encodedNames } from './claude'
import { cwdOfPid, hasActiveDescendant, isClaudeCli, type PsRow } from './procs'

/**
 * Heuristic Claude Code session states (plan §3, layer L3b).
 *
 * For every live interactive `claude` process we map its cwd to the matching
 * `~/.claude/projects/<encoded-cwd>` folder, read the *tail* of the newest
 * transcript, and classify what the session is doing right now:
 *
 *   - transcript written seconds ago                    → working
 *   - last record ends the turn (`turn_duration`,
 *     assistant `end_turn`)                             → input ("your turn")
 *   - assistant `tool_use` with no tool_result after it,
 *     process + descendants idle                        → permission (likely)
 *
 * These are *inferences* (confidence: 'heuristic'); the hook-fed layer of
 * phase 2 replaces them with exact states. Known limit: two sessions in the
 * same project share that project's newest transcript, so both terminals show
 * the same state until hooks disambiguate by session id.
 */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const TAIL_BYTES = 32 * 1024
/** A transcript written this recently is conclusive evidence of work. */
const FRESH_MS = 8_000
/** A pending tool younger than this is presumed still starting/running. */
const PENDING_TOOL_MS = 12_000

interface TailEvent {
  kind: 'turn-end' | 'pending-tool' | 'busy'
  ts: string | null
  tool?: string
}

interface TranscriptTail {
  event: TailEvent | null
  model?: string
  title?: string
  permissionMode?: string
  lastPrompt?: string
}

interface RawRecord {
  type?: string
  subtype?: string
  timestamp?: string
  aiTitle?: string
  permissionMode?: string
  lastPrompt?: string
  message?: {
    role?: string
    model?: string
    stop_reason?: string | null
    content?: unknown
  }
}

function lastToolUseName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i] as { type?: string; name?: string }
    if (item && item.type === 'tool_use') return item.name
  }
  return undefined
}

function firstLine(s: string, max: number): string {
  const line = s.split('\n', 1)[0].trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Parse the final records of a transcript, newest-first, collecting the last
 *  state-bearing event plus the metadata records Claude Code keeps at the tail
 *  (ai-title / permission-mode / last-prompt). */
async function readTail(file: string): Promise<TranscriptTail> {
  const out: TranscriptTail = { event: null }
  let text: string
  try {
    const fd = await open(file, 'r')
    try {
      const size = (await fd.stat()).size
      const offset = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES))
      await fd.read(buf, 0, buf.length, offset)
      text = buf.toString('utf8')
      if (offset > 0) text = text.slice(text.indexOf('\n') + 1)
    } finally {
      await fd.close()
    }
  } catch {
    return out
  }

  const lines = text.split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: RawRecord
    try {
      rec = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (rec.type === 'ai-title' && rec.aiTitle && out.title === undefined) out.title = rec.aiTitle
    if (rec.type === 'permission-mode' && rec.permissionMode && out.permissionMode === undefined)
      out.permissionMode = rec.permissionMode
    if (rec.type === 'last-prompt' && rec.lastPrompt && out.lastPrompt === undefined)
      out.lastPrompt = firstLine(rec.lastPrompt, 100)

    if (rec.type === 'assistant' && rec.message?.model && out.model === undefined)
      out.model = rec.message.model

    if (out.event) continue
    const ts = rec.timestamp ?? null
    if (rec.type === 'system' && rec.subtype === 'turn_duration') {
      out.event = { kind: 'turn-end', ts }
    } else if (rec.type === 'assistant') {
      const msg = rec.message
      const tool = lastToolUseName(msg?.content)
      if (msg?.stop_reason === 'tool_use' || tool) {
        out.event = { kind: 'pending-tool', ts, tool }
      } else if (msg?.stop_reason === 'end_turn') {
        out.event = { kind: 'turn-end', ts }
      } else {
        out.event = { kind: 'busy', ts }
      }
    } else if (rec.type === 'user') {
      // A tool_result (tool just ran) or a fresh prompt — the model's move.
      out.event = { kind: 'busy', ts }
    }
  }
  return out
}

/** Newest transcript in a project folder, or null. */
async function newestTranscript(dir: string): Promise<{ file: string; mtimeMs: number; sessionId: string } | null> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  let best: { file: string; mtimeMs: number; sessionId: string } | null = null
  await Promise.all(
    files.map(async (f) => {
      try {
        const st = await stat(join(dir, f))
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { file: join(dir, f), mtimeMs: st.mtimeMs, sessionId: f.replace(/\.jsonl$/, '') }
        }
      } catch {
        // raced a cleanup — skip
      }
    })
  )
  return best
}

function classify(
  tail: TranscriptTail,
  mtimeMs: number,
  proc: PsRow,
  rows: PsRow[]
): { state: AgentState; since: string | null; tool?: string } {
  const mtimeIso = new Date(mtimeMs).toISOString()
  if (Date.now() - mtimeMs < FRESH_MS) return { state: 'working', since: mtimeIso }

  const ev = tail.event
  if (!ev) return { state: 'unknown', since: mtimeIso }
  const since = ev.ts ?? mtimeIso

  switch (ev.kind) {
    case 'turn-end':
      return { state: 'input', since }
    case 'pending-tool': {
      const evAge = Date.now() - new Date(since).getTime()
      if (evAge < PENDING_TOOL_MS) return { state: 'working', since }
      // A tool that's genuinely executing shows up as the claude process (or a
      // descendant) doing something; a permission prompt leaves everything idle.
      if (proc.pcpu >= 5 || hasActiveDescendant(rows, proc.pid)) {
        return { state: 'working', since }
      }
      return { state: 'permission', since, tool: ev.tool }
    }
    case 'busy':
      return { state: 'working', since }
  }
}

async function sessionOf(
  proc: PsRow,
  rows: PsRow[],
  repoPaths: string[]
): Promise<AgentSessionState> {
  const cwd = await cwdOfPid(proc.pid)
  const repoPath =
    cwd === null ? null : (repoPaths.find((r) => cwd === r || cwd.startsWith(r + '/')) ?? null)

  const base: AgentSessionState = {
    sessionId: null,
    state: 'unknown',
    confidence: 'heuristic',
    since: null,
    pid: proc.pid,
    tty: proc.tty,
    cwd,
    repoPath
  }
  if (!cwd) return base

  for (const name of encodedNames(cwd)) {
    const newest = await newestTranscript(join(PROJECTS_DIR, name))
    if (!newest) continue
    const tail = await readTail(newest.file)
    const cls = classify(tail, newest.mtimeMs, proc, rows)
    return {
      ...base,
      sessionId: newest.sessionId,
      state: cls.state,
      since: cls.since,
      detail: cls.tool ? { tool: cls.tool } : undefined,
      model: tail.model,
      permissionMode: tail.permissionMode,
      title: tail.title,
      lastPrompt: tail.lastPrompt
    }
  }
  return base
}

/**
 * One session per controlling terminal: forks and helpers share the CLI's tty,
 * so the eldest claude pid per tty is the session process.
 */
export async function getAgentSessions(
  rows: PsRow[],
  repoPaths: string[]
): Promise<AgentSessionState[]> {
  const byTty = new Map<string, PsRow>()
  for (const r of rows) {
    if (!r.tty || !isClaudeCli(r)) continue
    const cur = byTty.get(r.tty)
    if (!cur || r.pid < cur.pid) byTty.set(r.tty, r)
  }
  return Promise.all([...byTty.values()].map((proc) => sessionOf(proc, rows, repoPaths)))
}
