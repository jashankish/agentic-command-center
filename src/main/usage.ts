import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { ClaudeUsage, UsageWindow } from '../shared/types'
import { redactError } from './redact'

const execFileAsync = promisify(execFile)

// Claude Code's `/usage` data comes from this undocumented OAuth endpoint. It is
// authenticated with the same OAuth access token Claude Code stores in the macOS
// Keychain. This is unofficial and may change — every failure degrades gracefully.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'

// The Keychain generic-password item Claude Code writes its credentials to.
const KEYCHAIN_SERVICE = 'Claude Code-credentials'

const EMPTY: UsageWindow = { utilization: 0, resetsAt: null }

// The usage endpoint rate-limits (429) aggressive polling, so keep our request
// rate low: a 2-minute cache, concurrent-call coalescing, and a backoff after a
// 429. Usage windows (5h / 7d) move slowly, so this is plenty fresh.
const CACHE_MS = 120_000
let cache: { at: number; value: ClaudeUsage } | null = null
// Last successful result — shown instead of an error when a refresh is
// throttled, so a transient 429 doesn't blank the widget.
let lastGood: ClaudeUsage | null = null
// While rate-limited, don't hit the endpoint again until this time.
let backoffUntil = 0
// Coalesce concurrent callers (e.g. React StrictMode's double mount) onto one
// in-flight request instead of firing several at once.
let inflight: Promise<ClaudeUsage> | null = null
// Poll the credential store faster while the widget is showing an error — the
// user may be signing in to Claude Code right now.
let lastResultHadError = false

const CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json')
const CREDENTIAL_POLL_OK_MS = 60_000
const CREDENTIAL_POLL_ERR_MS = 15_000
const CREDENTIAL_DEBOUNCE_MS = 200

interface OauthCreds {
  accessToken: string
  expiresAt?: number
}

/**
 * Read and parse Claude Code's OAuth credentials. Tries the macOS Keychain
 * first, then falls back to the file-based store `~/.claude/.credentials.json`
 * (used on some platforms/versions, and a safety net if an update moves the
 * credential out of the Keychain). The error surfaced names which path failed.
 */
async function readCredentials(): Promise<OauthCreds> {
  let parsed: Record<string, unknown> | undefined
  let keychainError: unknown
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w'
    ])
    parsed = JSON.parse(stdout.trim())
  } catch (err) {
    keychainError = err
    try {
      const file = join(homedir(), '.claude', '.credentials.json')
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      // Neither store worked — report the original Keychain failure, which is
      // the more informative one on macOS.
      throw new Error(`Keychain read failed: ${redactError(keychainError)}`)
    }
  }

  if (!parsed) throw new Error('No Claude credentials found')
  const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>
  if (!oauth || typeof oauth.accessToken !== 'string') {
    throw new Error('No Claude OAuth token found in credentials')
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined
  }
}

/** Cheap fingerprint of the active OAuth token — used to detect /login and
 *  periodic refreshes without storing the token itself. */
async function credentialFingerprint(): Promise<string | null> {
  try {
    const { accessToken, expiresAt } = await readCredentials()
    return `${expiresAt ?? 0}:${accessToken.length}:${accessToken.slice(-8)}`
  } catch {
    return null
  }
}

/** Drop cached usage so the next fetch re-reads credentials from Keychain/file. */
export function invalidateUsageCache(): void {
  cache = null
  lastGood = null
  backoffUntil = 0
}

/** Map a usage window object; returns null when the API omits it (e.g. null seven_day_opus). */
function toWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { utilization?: number; resets_at?: string }
  return {
    utilization: Math.round(typeof w.utilization === 'number' ? w.utilization : 0),
    resetsAt: w.resets_at ?? null
  }
}

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value
  // While backing off from a 429, serve the last good data without refetching.
  if (now < backoffUntil && lastGood) return { ...lastGood }
  if (inflight) return inflight

  inflight = (async () => {
    const result = await fetchUsage()
    lastResultHadError = !!result.error
    if (!result.error) {
      lastGood = result
      cache = { at: Date.now(), value: result }
      return result
    }
    // On error, prefer the last good snapshot so the widget doesn't flicker to
    // "unavailable" on a transient throttle; cache it briefly to ease the rate.
    if (lastGood) {
      cache = { at: Date.now(), value: lastGood }
      return { ...lastGood }
    }
    cache = { at: Date.now(), value: result }
    return result
  })().finally(() => {
    inflight = null
  })

  return inflight
}

async function fetchUsage(): Promise<ClaudeUsage> {
  try {
    const { accessToken, expiresAt } = await readCredentials()

    // We don't implement token refresh — if Claude Code's token has expired, point
    // the user back to Claude Code (running it refreshes the Keychain token).
    if (typeof expiresAt === 'number' && Date.now() > expiresAt) {
      return { session: EMPTY, weekly: EMPTY, weeklyOpus: EMPTY, error: 'stale' }
    }

    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json'
      }
    })
    if (res.status === 429) {
      // Honor Retry-After (seconds) when present; otherwise back off 5 minutes.
      const retry = Number(res.headers.get('retry-after'))
      backoffUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 300_000)
      throw new Error('Usage request failed (429 — rate limited)')
    }
    if (!res.ok) throw new Error(`Usage request failed (${res.status})`)

    const data = (await res.json()) as Record<string, unknown>
    return {
      session: toWindow(data.five_hour) ?? EMPTY,
      weekly: toWindow(data.seven_day) ?? EMPTY,
      weeklyOpus: toWindow(data.seven_day_opus)
    }
  } catch (err) {
    const message = redactError(err)
    // Surfaced (redacted) so the real failure cause is diagnosable from logs and
    // the widget tooltip — never contains the token (redactError scrubs secrets).
    console.error('[usage] unavailable:', message)
    return { session: EMPTY, weekly: EMPTY, weeklyOpus: EMPTY, error: message }
  }
}

/**
 * Watch Claude Code's credential store and push when the OAuth token changes.
 * On macOS the token lives in Keychain (no fs events), so we poll; the file
 * fallback is fs.watch'ed when present. Returns a cleanup function.
 */
export function initUsageCredentialWatch(onChange: () => void): () => void {
  let lastFp: string | null | undefined
  let debounce: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const watchers: FSWatcher[] = []

  const schedulePoll = (): void => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(
      () => void check(),
      lastResultHadError ? CREDENTIAL_POLL_ERR_MS : CREDENTIAL_POLL_OK_MS
    )
  }

  const notify = (): void => {
    invalidateUsageCache()
    onChange()
    schedulePoll()
  }

  const check = async (): Promise<void> => {
    const fp = await credentialFingerprint()
    if (lastFp === undefined) {
      lastFp = fp
      return
    }
    if (fp !== lastFp) {
      lastFp = fp
      notify()
    }
  }

  const onFsEvent = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => void check(), CREDENTIAL_DEBOUNCE_MS)
  }

  try {
    watchers.push(watch(CREDENTIALS_FILE, onFsEvent))
  } catch {
    // File may not exist yet (macOS Keychain-only installs).
  }
  try {
    watchers.push(
      watch(join(homedir(), '.claude'), (_type, name) => {
        if (name === '.credentials.json') onFsEvent()
      })
    )
  } catch {
    // ~/.claude may not exist before first Claude Code run.
  }

  void check()
  schedulePoll()

  return () => {
    if (debounce) clearTimeout(debounce)
    if (pollTimer) clearInterval(pollTimer)
    for (const w of watchers) w.close()
  }
}
