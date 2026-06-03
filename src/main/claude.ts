import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  ClaudeActivity,
  ClaudeModelClass,
  ClaudeProjectActivity
} from '../shared/types'
import { redactError } from './redact'

// Per-MTok USD pricing by model class (input / output / cache-write / cache-read).
// Unknown models fall back to Sonnet rates. These are estimates — the endpoint in
// usage.ts remains the source of truth for quota; this is a cost approximation.
const PRICING: Record<Exclude<ClaudeModelClass, 'other'>, {
  in: number
  out: number
  cacheWrite: number
  cacheRead: number
}> = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 0.8, out: 4, cacheWrite: 1.0, cacheRead: 0.08 }
}

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
}

function classify(model: string | undefined): ClaudeModelClass {
  if (!model) return 'other'
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return 'other'
}

function costOf(cls: ClaudeModelClass, u: Usage): number {
  const p = cls === 'other' ? PRICING.sonnet : PRICING[cls]
  return (
    ((u.input_tokens ?? 0) * p.in +
      (u.output_tokens ?? 0) * p.out +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead) /
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
function encodedNames(repoPath: string): string[] {
  return [repoPath.replace(/\//g, '-'), repoPath.replace(/[/.]/g, '-')]
}

function emptyModels(): Record<ClaudeModelClass, number> {
  return { opus: 0, sonnet: 0, haiku: 0, other: 0 }
}

/** Aggregate one project's transcript folder into a per-project activity record. */
async function readProject(repoPath: string, dir: string): Promise<ClaudeProjectActivity | null> {
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
      let obj: { message?: { usage?: Usage; model?: string }; timestamp?: string }
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const usage = obj.message?.usage
      if (!usage) continue
      const cls = classify(obj.message?.model)
      const cost = costOf(cls, usage)
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

    for (const repoPath of repoPaths) {
      const match = encodedNames(repoPath).find((n) => existing.has(n))
      if (!match) continue
      const proj = await readProject(repoPath, join(PROJECTS_DIR, match))
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
