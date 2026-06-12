import { watch, type FSWatcher } from 'fs'
import { mkdir, readdir, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { AgentSessionState, AgentState } from '../shared/types'
import { psScan } from './procs'
import { redactSecrets } from './redact'

/**
 * Hook-fed Claude session states (plan §3, layer L3a).
 *
 * The opt-in hook script (hooks-setup.ts) appends one JSON line per Claude
 * Code lifecycle event to `<userData>/agent-events/<session_id>.jsonl`. This
 * module watches that directory, folds each file through a small state
 * machine, and exposes exact per-session states (confidence: 'event'):
 *
 *   SessionStart / UserPromptSubmit            → working
 *   PermissionRequest / Notification(permission_prompt) → permission
 *   Notification(idle_prompt) / Stop           → input ("your turn")
 *   SessionEnd / pid gone                      → ended (entry clears)
 *
 * Clearing rule (the hybrid that makes this sound): nothing fires when the
 * user *answers* a permission prompt, but the transcript gets the tool_result
 * the instant the approved tool runs — so a transcript write newer than the
 * waiting event downgrades permission/input back to working. Waiting sessions'
 * transcripts are fs.watch'ed for an instant clear, with the GC sweep as
 * backup.
 *
 * Event files are transcript-class data: they live 0700 under userData, are
 * deleted shortly after SessionEnd (or when the pid dies), and only short
 * redacted summaries of tool inputs ever leave the main process.
 */

const ENDED_TTL_MS = 60_000
const GC_INTERVAL_MS = 30_000
const ORPHAN_MAX_AGE_MS = 7 * 24 * 3600_000
const DEBOUNCE_MS = 150

interface HookPayload {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  permission_mode?: string
  model?: string
  prompt?: string
  tool_name?: string
  tool_input?: unknown
  notification_type?: string
  message?: string
}

interface EventLine {
  ts?: string
  pid?: number
  tty?: string
  event?: HookPayload
}

interface EventSession {
  sessionId: string
  state: AgentState
  since: string
  pid: number
  tty: string | null
  cwd: string | null
  transcriptPath: string | null
  model?: string
  permissionMode?: string
  lastPrompt?: string
  detail?: { tool?: string; summary?: string }
  /** Epoch ms of the event that set a waiting state (clearing-rule anchor). */
  waitingSinceMs?: number
  endedAtMs?: number
}

let eventsDir: string | null = null
let onChange: (() => void) | null = null
let dirWatcher: FSWatcher | null = null
let gcTimer: ReturnType<typeof setInterval> | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null

const registry = new Map<string, EventSession>()
const transcriptWatchers = new Map<string, FSWatcher>()

function firstLine(s: string, max: number): string {
  const line = s.split('\n', 1)[0].trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Short, redacted description of what a tool wants to do. */
function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined
  const raw =
    pick(o.command) ?? pick(o.file_path) ?? pick(o.url) ?? pick(o.pattern) ?? pick(o.prompt)
  return raw ? redactSecrets(firstLine(raw, 80)) : undefined
}

function notifySoon(): void {
  if (!onChange || notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    onChange?.()
  }, DEBOUNCE_MS)
}

function setWaiting(s: EventSession, state: 'permission' | 'input', ts: string | undefined): void {
  s.state = state
  s.since = ts ?? new Date().toISOString()
  s.waitingSinceMs = new Date(s.since).getTime()
}

function applyEvent(s: EventSession, line: EventLine): void {
  const ev = line.event ?? {}
  const ts = line.ts

  if (typeof line.pid === 'number' && line.pid > 0) s.pid = line.pid
  if (line.tty) s.tty = line.tty
  if (ev.cwd) s.cwd = ev.cwd
  if (ev.transcript_path) s.transcriptPath = ev.transcript_path
  if (ev.permission_mode) s.permissionMode = ev.permission_mode

  switch (ev.hook_event_name) {
    case 'SessionStart':
      s.state = 'working'
      s.since = ts ?? s.since
      if (ev.model) s.model = ev.model
      break
    case 'UserPromptSubmit':
      s.state = 'working'
      s.since = ts ?? s.since
      s.detail = undefined
      if (ev.prompt) s.lastPrompt = firstLine(ev.prompt, 100)
      break
    case 'PermissionRequest':
      setWaiting(s, 'permission', ts)
      s.detail = { tool: ev.tool_name, summary: summarizeToolInput(ev.tool_input) }
      break
    case 'Notification':
      if (ev.notification_type === 'permission_prompt') {
        setWaiting(s, 'permission', ts)
        // PermissionRequest usually carried the rich detail already; keep it.
        if (!s.detail) {
          s.detail = { summary: ev.message ? redactSecrets(firstLine(ev.message, 80)) : undefined }
        }
      } else if (ev.notification_type === 'idle_prompt') {
        setWaiting(s, 'input', ts)
      }
      break
    case 'Stop':
      setWaiting(s, 'input', ts)
      s.detail = undefined
      break
    case 'SessionEnd':
      s.state = 'ended'
      s.since = ts ?? s.since
      s.endedAtMs = Date.now()
      break
    default:
      break
  }
}

/** Re-fold one session file from scratch (idempotent, order = append order). */
async function applyFile(file: string): Promise<void> {
  if (!eventsDir) return
  const sessionId = file.replace(/\.jsonl$/, '')
  let text: string
  try {
    text = await readFile(join(eventsDir, file), 'utf8')
  } catch {
    return
  }
  const s: EventSession = registry.get(sessionId) ?? {
    sessionId,
    state: 'unknown',
    since: new Date().toISOString(),
    pid: 0,
    tty: null,
    cwd: null,
    transcriptPath: null
  }
  // Reset state-machine output (identity fields persist) before re-folding.
  s.state = 'unknown'
  s.detail = undefined
  s.waitingSinceMs = undefined
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      applyEvent(s, JSON.parse(raw) as EventLine)
    } catch {
      // torn or malformed line — skip
    }
  }
  registry.set(sessionId, s)
  syncTranscriptWatcher(s)
}

/** The instant-clear half of the clearing rule: while a session waits, watch
 *  its transcript; the first write newer than the waiting event means the
 *  user answered and Claude is moving again. */
function syncTranscriptWatcher(s: EventSession): void {
  const key = s.sessionId
  const waiting = (s.state === 'permission' || s.state === 'input') && !!s.transcriptPath
  const existing = transcriptWatchers.get(key)
  if (!waiting) {
    if (existing) {
      existing.close()
      transcriptWatchers.delete(key)
    }
    return
  }
  if (existing) return
  try {
    const w = watch(s.transcriptPath!, () => void clearIfTranscriptAdvanced(s))
    w.on('error', () => {
      w.close()
      transcriptWatchers.delete(key)
    })
    transcriptWatchers.set(key, w)
  } catch {
    // transcript missing/unreadable — the GC stat sweep still covers clearing
  }
}

async function clearIfTranscriptAdvanced(s: EventSession): Promise<void> {
  if (s.state !== 'permission' && s.state !== 'input') return
  if (!s.transcriptPath || !s.waitingSinceMs) return
  try {
    const st = await stat(s.transcriptPath)
    if (st.mtimeMs > s.waitingSinceMs + 250) {
      s.state = 'working'
      s.since = new Date(st.mtimeMs).toISOString()
      s.waitingSinceMs = undefined
      s.detail = undefined
      syncTranscriptWatcher(s)
      notifySoon()
    }
  } catch {
    // transcript gone — leave it to the pid sweep
  }
}

async function gcSweep(): Promise<void> {
  if (!eventsDir || registry.size === 0) return
  const rows = await psScan()
  const livePids = new Set(rows.map((r) => r.pid))
  let changed = false

  for (const s of registry.values()) {
    // Belt-and-suspenders clearing for watchers that never fired.
    await clearIfTranscriptAdvanced(s)

    if (s.state !== 'ended' && s.pid > 0 && !livePids.has(s.pid)) {
      s.state = 'ended'
      s.endedAtMs = Date.now()
      changed = true
    }
    if (s.state === 'ended' && s.endedAtMs && Date.now() - s.endedAtMs > ENDED_TTL_MS) {
      registry.delete(s.sessionId)
      syncTranscriptWatcher({ ...s, state: 'ended' })
      transcriptWatchers.get(s.sessionId)?.close()
      transcriptWatchers.delete(s.sessionId)
      rm(join(eventsDir, `${s.sessionId}.jsonl`), { force: true }).catch(() => {})
      changed = true
    }
  }
  if (changed) notifySoon()
}

/** Hook-fed sessions for the merge layer (ended ones have already cleared). */
export function getEventSessions(): AgentSessionState[] {
  const out: AgentSessionState[] = []
  for (const s of registry.values()) {
    if (s.state === 'ended' || s.state === 'unknown') continue
    out.push({
      sessionId: s.sessionId,
      state: s.state,
      confidence: 'event',
      since: s.since,
      detail: s.detail,
      model: s.model,
      permissionMode: s.permissionMode,
      lastPrompt: s.lastPrompt,
      pid: s.pid,
      tty: s.tty,
      cwd: s.cwd,
      repoPath: null
    })
  }
  return out
}

/** Start watching the events directory. Idempotent; safe if the dir is empty
 *  (hooks not installed) — it simply stays quiet until lines appear. */
export async function initAgentEvents(dir: string, changed: () => void): Promise<void> {
  eventsDir = dir
  onChange = changed
  await mkdir(dir, { recursive: true, mode: 0o700 })

  // Replay whatever accumulated while the app was closed; drop ancient orphans.
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    files = []
  }
  for (const f of files) {
    try {
      const st = await stat(join(dir, f))
      if (Date.now() - st.mtimeMs > ORPHAN_MAX_AGE_MS) {
        await rm(join(dir, f), { force: true })
        continue
      }
    } catch {
      continue
    }
    await applyFile(f)
  }
  // Reconcile replayed states against reality before the first paint.
  await gcSweep()

  try {
    dirWatcher = watch(dir, (_type, filename) => {
      if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
        void applyFile(filename).then(notifySoon)
      }
    })
    dirWatcher.on('error', () => {
      dirWatcher?.close()
      dirWatcher = null
    })
  } catch {
    // Watch failures degrade to poll-driven freshness (the panel polls anyway).
  }

  if (!gcTimer) {
    gcTimer = setInterval(() => void gcSweep(), GC_INTERVAL_MS)
    // Don't let the sweep keep the process alive at quit.
    gcTimer.unref?.()
  }
}
