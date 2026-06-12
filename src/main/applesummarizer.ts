import { spawn } from 'child_process'
import { accessSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { app } from 'electron'

export interface SummarizerAvailability {
  available: boolean
  /** When unavailable: short human-readable reason / how to enable. */
  hint?: string
}

export interface SummarizeRequest {
  id: string
  text: string
}

const HINTS: Record<string, string> = {
  deviceNotEligible: 'This Mac does not support Apple Intelligence',
  appleIntelligenceNotEnabled: 'Enable Apple Intelligence in System Settings for commit summaries',
  modelNotReady: 'Apple Intelligence model is downloading — summaries will appear when ready',
  other: 'On-device summarizer unavailable'
}

// How long an "unavailable" verdict is trusted before probing again. The model
// can become ready at any moment (download finishing, Apple Intelligence being
// switched on), so transient reasons get re-checked; deviceNotEligible never is.
const RECHECK_MS = 60_000

function resolveHelper(): string | null {
  const candidates = [
    join(process.resourcesPath, 'bin', 'commit-summarizer'), // packaged (extraResources)
    join(app.getAppPath(), 'resources', 'bin', 'commit-summarizer') // dev (project root)
  ]
  for (const c of candidates) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return null
}

/** Gates that can't change while the process is alive (hardware / OS / bundle). */
function staticGate(): SummarizerAvailability | null {
  // Darwin 25 == macOS 26, the first release with the FoundationModels runtime.
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || parseInt(release(), 10) < 25) {
    return { available: false, hint: 'Requires an Apple Silicon Mac on macOS 26 or later' }
  }
  if (!resolveHelper()) {
    return { available: false, hint: 'Summarizer helper not bundled (build with Xcode 26+)' }
  }
  return null
}

let cached: { result: SummarizerAvailability; reason?: string; at: number } | null = null

function shouldProbe(): boolean {
  if (!cached) return true
  if (cached.result.available) return false
  if (cached.reason === 'deviceNotEligible') return false
  return Date.now() - cached.at >= RECHECK_MS
}

function noteStatus(parsed: Record<string, unknown>): SummarizerAvailability {
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'other'
  const result: SummarizerAvailability =
    parsed.available === true
      ? { available: true }
      : { available: false, hint: HINTS[reason] ?? HINTS.other }
  cached = { result, reason, at: Date.now() }
  return result
}

export async function checkAvailability(): Promise<SummarizerAvailability> {
  const gate = staticGate()
  if (gate) return gate
  if (!shouldProbe()) return cached!.result

  const helper = resolveHelper()! // staticGate verified it exists
  const line = await new Promise<string | null>((resolve) => {
    const child = spawn(helper, ['--check'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let settled = false
    const finish = (v: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, 5000)
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const nl = out.indexOf('\n')
      if (nl !== -1) finish(out.slice(0, nl))
    })
    child.on('close', () => finish(out.split('\n')[0] || null))
    child.on('error', () => finish(null))
  })

  try {
    if (line) return noteStatus(JSON.parse(line))
  } catch {
    // unparsable output → treat as unavailable below
  }
  return noteStatus({ available: false, reason: 'other' })
}

/**
 * Summarize a batch of commits with one helper process. Results stream back via
 * `onResult` as the model finishes each item; ids the helper never answers
 * (timeout, model went away) simply get no callback so callers can retry later.
 */
export async function summarizeBatch(
  items: SummarizeRequest[],
  onResult: (id: string, summary: string | null, errorCode?: string) => void
): Promise<void> {
  const helper = resolveHelper()
  if (!helper || items.length === 0) return

  await new Promise<void>((resolve) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let sawStatus = false
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (stderr.trim()) console.warn('commit-summarizer:', stderr.trim())
      resolve()
    }

    // The first complete model response can take a few seconds (cold load);
    // budget generously and kill anything that overruns — unanswered commits
    // stay uncached and are retried on a later cycle.
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      Math.min(120_000, 10_000 + 8_000 * items.length)
    )

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (!sawStatus) {
        // Line 1 is always the availability status — refresh the cache for free.
        sawStatus = true
        noteStatus(parsed)
        return
      }
      const id = typeof parsed.id === 'string' ? parsed.id : null
      if (!id) return
      if (typeof parsed.summary === 'string') onResult(id, parsed.summary)
      else onResult(id, null, typeof parsed.error === 'string' ? parsed.error : 'other')
    }

    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('close', finish)
    child.on('error', finish)

    // If the helper exits early (model unavailable), writes hit a closed pipe.
    child.stdin.on('error', () => {})
    try {
      for (const item of items) child.stdin.write(JSON.stringify(item) + '\n')
      child.stdin.end()
    } catch {
      // closed pipe — close/error handlers settle the promise
    }
  })
}
