import { execFile } from 'child_process'
import { accessSync } from 'fs'
import { promisify } from 'util'
import type { TmuxPaneRef } from '../shared/types'

const execFileAsync = promisify(execFile)

/**
 * tmux pane↔client mapping (plan §2 item 10, the last stretch feature).
 *
 * A Claude session inside tmux runs on a pty owned by the tmux *server* — its
 * tty never appears in any terminal tab. The chain back to something focusable
 * is: claude tty → pane → pane's tmux session → a *client* attached to that
 * session → the client's tty → the Terminal/iTerm2 tab we already enumerate.
 *
 * Focusing then means: switch that client to the right session, select the
 * window and pane inside tmux, and bring the hosting tab forward with the
 * existing AppleScript path.
 */

export interface TmuxPane extends TmuxPaneRef {
  /** Normalized pty of the pane itself (e.g. "ttys020"). */
  tty: string
}

export interface TmuxMap {
  /** Pane pty → pane. */
  panesByTty: Map<string, TmuxPane>
  /** tmux session name → normalized ttys of attached clients. */
  clientsBySession: Map<string, string[]>
}

const SEP = ''

function resolveTmux(): string {
  for (const c of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return 'tmux'
}

const tmuxBin = resolveTmux()

const normTty = (raw: string): string => raw.trim().replace(/^\/dev\//, '')

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(tmuxBin, args, { timeout: 3000 })
  return stdout
}

const CACHE_MS = 4000
let cache: { at: number; value: TmuxMap | null } | null = null

/** Pane/client topology of the running tmux server, or null when there isn't
 *  one (the common case — resolved with a single fast failing call). */
export async function getTmuxMap(): Promise<TmuxMap | null> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value

  let value: TmuxMap | null = null
  try {
    const [panesOut, clientsOut] = await Promise.all([
      tmux(['list-panes', '-a', '-F', `#{pane_tty}${SEP}#{session_name}${SEP}#{window_index}${SEP}#{pane_id}`]),
      tmux(['list-clients', '-F', `#{client_tty}${SEP}#{session_name}`])
    ])
    const panesByTty = new Map<string, TmuxPane>()
    for (const line of panesOut.split('\n')) {
      if (!line.trim()) continue
      const [tty, session, windowIndex, pane] = line.split(SEP)
      if (!tty || !pane) continue
      panesByTty.set(normTty(tty), {
        tty: normTty(tty),
        session: session ?? '',
        windowIndex: Number(windowIndex) || 0,
        pane
      })
    }
    const clientsBySession = new Map<string, string[]>()
    for (const line of clientsOut.split('\n')) {
      if (!line.trim()) continue
      const [tty, session] = line.split(SEP)
      if (!tty || session === undefined) continue
      const list = clientsBySession.get(session) ?? []
      list.push(normTty(tty))
      clientsBySession.set(session, list)
    }
    value = { panesByTty, clientsBySession }
  } catch {
    // No server running (or tmux missing) — that's the normal quiet path.
    value = null
  }
  cache = { at: Date.now(), value }
  return value
}

/** Reveal a pane: point the client at its session, then select window + pane.
 *  The caller follows up by focusing the client's terminal tab. */
export async function revealTmuxPane(ref: TmuxPaneRef, clientTty: string): Promise<void> {
  // Values reach tmux as plain execFile args (no shell), but validate the
  // shapes we generated anyway — they round-tripped through the renderer.
  if (!/^%\d+$/.test(ref.pane) || !/^ttys\d{1,5}$/.test(clientTty)) {
    throw new Error('Invalid tmux focus target.')
  }
  const windowTarget = `${ref.session}:${ref.windowIndex}`
  await tmux(['switch-client', '-c', `/dev/${clientTty}`, '-t', ref.session])
  await tmux(['select-window', '-t', windowTarget])
  await tmux(['select-pane', '-t', ref.pane])
}
