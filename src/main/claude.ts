import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  ClaudeActivity,
  ClaudeModelClass,
  ClaudeProjectActivity
} from '../shared/types'
import { redactError } from './redact'

// Per-MTok USD pricing matched against the model id, most specific rule first.
// Cache rates derive from the input rate (5m write 1.25×, 1h write 2×, read 0.1×),
// which matches every published Claude price. Unknown models fall back to Sonnet
// rates. These are estimates — the endpoint in usage.ts remains the source of
// truth for quota; this is a cost approximation.
interface ModelPrice {
  in: number
  out: number
}

const PRICE_RULES: { match: RegExp; cls: ClaudeModelClass; price: ModelPrice }[] = [
  { match: /fable|mythos/, cls: 'fable', price: { in: 10, out: 50 } },
  { match: /opus-4-[5-9]/, cls: 'opus', price: { in: 5, out: 25 } },
  { match: /opus/, cls: 'opus', price: { in: 15, out: 75 } }, // legacy Opus 4.0/4.1
  { match: /sonnet/, cls: 'sonnet', price: { in: 3, out: 15 } },
  { match: /haiku-4/, cls: 'haiku', price: { in: 1, out: 5 } },
  { match: /haiku/, cls: 'haiku', price: { in: 0.8, out: 4 } } // legacy Haiku 3.5
]

const FALLBACK_PRICE: ModelPrice = { in: 3, out: 15 }

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PLANS_DIR = join(homedir(), '.claude', 'plans')
const ACTIVE_MS = 5 * 60_000

// Parsing every transcript is non-trivial, so cache the aggregate briefly.
const CACHE_MS = 45_000
let cache: { at: number; key: string; value: ClaudeActivity } | null = null
let inflight: Promise<ClaudeActivity> | null = null

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

function modelInfo(model: string | undefined): { cls: ClaudeModelClass; price: ModelPrice } {
  if (model) {
    const m = model.toLowerCase()
    for (const rule of PRICE_RULES) {
      if (rule.match.test(m)) return { cls: rule.cls, price: rule.price }
    }
  }
  return { cls: 'other', price: FALLBACK_PRICE }
}

/** Cache-write tokens weighted by TTL premium, in input-price units. */
function cacheWriteWeighted(u: Usage): number {
  const m5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  if (m5 + h1 > 0) return m5 * 1.25 + h1 * 2
  return (u.cache_creation_input_tokens ?? 0) * 1.25
}

function costOf(price: ModelPrice, u: Usage): number {
  return (
    (((u.input_tokens ?? 0) + cacheWriteWeighted(u) + (u.cache_read_input_tokens ?? 0) * 0.1) *
      price.in +
      (u.output_tokens ?? 0) * price.out) /
    1e6
  )
}

function tokensOf(u: Usage): number {
  return (
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  )
}

/** Claude Code encodes a project dir as its cwd with `/` and `.` turned to `-`. */
export function encodedNames(repoPath: string): string[] {
  return [repoPath.replace(/\//g, '-'), repoPath.replace(/[/.]/g, '-')]
}

function emptyModels(): Record<ClaudeModelClass, number> {
  return { opus: 0, sonnet: 0, haiku: 0, fable: 0, other: 0 }
}

/**
 * Aggregate one project's transcript folder into a per-project activity record.
 * `seen` spans the whole compute pass: Claude Code writes several lines for the
 * same API response (streamed updates, and history copied into forked/resumed
 * session files), all repeating the same usage object — count each once.
 */
async function readProject(
  repoPath: string,
  dir: string,
  seen: Set<string>
): Promise<ClaudeProjectActivity | null> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  if (!files.length) return null

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const weekMs = Date.now() - 7 * 24 * 60_000 * 60

  const proj: ClaudeProjectActivity = {
    path: repoPath,
    costToday: 0,
    costWeek: 0,
    costTotal: 0,
    tokensToday: 0,
    sessions: files.length,
    lastActivity: null,
    active: false,
    models: emptyModels()
  }
  let lastMs = 0

  for (const file of files) {
    const full = join(dir, file)
    let content: string
    let mtimeMs = 0
    try {
      const [c, st] = await Promise.all([readFile(full, 'utf8'), stat(full)])
      content = c
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }
    if (mtimeMs > lastMs) lastMs = mtimeMs

    for (const line of content.split('\n')) {
      if (!line) continue
      let obj: {
        message?: { usage?: Usage; model?: string; id?: string }
        requestId?: string
        timestamp?: string
      }
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const usage = obj.message?.usage
      if (!usage) continue
      if (obj.message?.id && obj.requestId) {
        const key = `${obj.message.id}:${obj.requestId}`
        if (seen.has(key)) continue
        seen.add(key)
      }
      const { cls, price } = modelInfo(obj.message?.model)
      const cost = costOf(price, usage)
      proj.costTotal += cost
      proj.models[cls] += cost

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
      if (ts) {
        if (ts > lastMs) lastMs = ts
        if (ts >= weekMs) proj.costWeek += cost
        if (ts >= todayMs) {
          proj.costToday += cost
          proj.tokensToday += tokensOf(usage)
        }
      }
    }
  }

  if (lastMs) {
    proj.lastActivity = new Date(lastMs).toISOString()
    proj.active = Date.now() - lastMs < ACTIVE_MS
  }
  return proj
}

async function recentPlans(): Promise<string[]> {
  try {
    const files = (await readdir(PLANS_DIR)).filter((f) => f.endsWith('.md'))
    const withTime = await Promise.all(
      files.map(async (f) => ({ f, t: (await stat(join(PLANS_DIR, f))).mtimeMs }))
    )
    return withTime
      .sort((a, b) => b.t - a.t)
      .slice(0, 8)
      .map((x) => x.f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

async function compute(repoPaths: string[]): Promise<ClaudeActivity> {
  const result: ClaudeActivity = {
    projects: [],
    costToday: 0,
    costWeek: 0,
    costTotal: 0,
    plans: [],
    available: false
  }
  try {
    const existing = new Set(await readdir(PROJECTS_DIR))
    result.available = true

    // One dedupe set across every project so history copied between session
    // files (forks/resumes) is never double-counted.
    const seen = new Set<string>()
    for (const repoPath of repoPaths) {
      const match = encodedNames(repoPath).find((n) => existing.has(n))
      if (!match) continue
      const proj = await readProject(repoPath, join(PROJECTS_DIR, match), seen)
      if (!proj) continue
      result.projects.push(proj)
      result.costToday += proj.costToday
      result.costWeek += proj.costWeek
      result.costTotal += proj.costTotal
    }
    result.projects.sort((a, b) => b.costTotal - a.costTotal)
    result.plans = await recentPlans()
  } catch (err) {
    result.error = redactError(err)
  }
  return result
}

export async function getClaudeActivity(repoPaths: string[]): Promise<ClaudeActivity> {
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
