import { simpleGit } from 'simple-git'
import { basename } from 'path'
import Store from 'electron-store'
import type { CommitFeed, CommitFeedEntry } from '../shared/types'
import { webUrlFromRemote } from './git'
import { checkAvailability, summarizeBatch } from './applesummarizer'

const SEP = String.fromCharCode(0x1f)

const MAX_PER_CYCLE = 15
const MAX_PERSISTED = 1000
const MAX_CONTEXT_CHARS = 2500
const MAX_MESSAGE_CHARS = 1200
const MAX_STAT_LINES = 15

interface CacheEntry {
  text: string
  /** Genuine model output (persisted) vs raw-message fallback (session only). */
  fromModel: boolean
}

// hash → summary. Hydrated from disk so a restart doesn't re-summarize.
const summaryCache = new Map<string, CacheEntry>()

const cacheStore = new Store<{ summaries: [string, string][] }>({
  name: 'summary-cache',
  defaults: { summaries: [] }
})
for (const [hash, text] of cacheStore.get('summaries')) {
  summaryCache.set(hash, { text, fromModel: true })
}

let summarizationRunning = false

function persistCache(): void {
  const persisted: [string, string][] = []
  for (const [hash, entry] of summaryCache) {
    if (entry.fromModel) persisted.push([hash, entry.text])
  }
  cacheStore.set('summaries', persisted.slice(-MAX_PERSISTED))
}

// Reject runaway or refused model output instead of caching it forever.
function plausible(s: string): boolean {
  return s.length > 0 && s.length <= 90 && s.split(/\s+/).length <= 14
}

/** Full message plus per-file change stats — more signal than the subject line. */
async function commitContext(e: CommitFeedEntry): Promise<string> {
  try {
    const git = simpleGit(e.repoPath)
    const [message, numstat] = await Promise.all([
      git.raw(['show', e.hash, '--no-patch', '--format=%B']),
      git.raw(['show', e.hash, '--numstat', '--format='])
    ])
    const body = message.trim().slice(0, MAX_MESSAGE_CHARS)
    const stats = numstat
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_STAT_LINES)
      .map((l) => l.trim())
      .join('\n')
    const text = stats ? `${body}\n\nFiles changed (added\tremoved\tpath):\n${stats}` : body
    return text.slice(0, MAX_CONTEXT_CHARS)
  } catch {
    return e.message
  }
}

async function runSummarization(entries: CommitFeedEntry[]): Promise<void> {
  const pending = entries.filter((e) => !summaryCache.has(e.hash)).slice(0, MAX_PER_CYCLE)
  if (pending.length === 0) return

  const byHash = new Map(pending.map((e) => [e.hash, e]))
  const items = await Promise.all(
    pending.map(async (e) => ({ id: e.hash, text: await commitContext(e) }))
  )

  let gotSummaries = false
  await summarizeBatch(items, (id, summary, errorCode) => {
    const entry = byHash.get(id)
    if (!entry) return
    if (summary && plausible(summary)) {
      summaryCache.set(id, { text: summary, fromModel: true })
      entry.summary = summary
      gotSummaries = true
    } else if (errorCode !== 'unavailable') {
      // Genuine per-item failure (guardrail, context, junk output): show the raw
      // message for this session but retry after a restart. 'unavailable' stays
      // uncached so it retries as soon as the model is ready.
      summaryCache.set(id, { text: entry.message, fromModel: false })
    }
  })
  if (gotSummaries) persistCache()
}

function relativeTime(dateStr: string): string {
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`
}

async function repoEntries(repoPath: string): Promise<CommitFeedEntry[]> {
  try {
    const git = simpleGit(repoPath)
    if (!(await git.checkIsRepo())) return []

    let remoteUrl: string | null = null
    try {
      remoteUrl = webUrlFromRemote((await git.remote(['get-url', 'origin'])) as string)
    } catch {
      // no remote configured
    }

    const out = await git.raw([
      'log',
      '--all',
      '--no-merges',
      '-5',
      `--pretty=format:%h${SEP}%s${SEP}%an${SEP}%aI`
    ])

    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, message, author, date] = line.split(SEP)
        const cached = summaryCache.get(hash ?? '')?.text
        return {
          repoPath,
          repoName: basename(repoPath),
          hash: hash ?? '',
          message: message ?? '',
          summary: cached ?? message ?? '',
          author: author ?? '',
          date: date ?? '',
          relative: relativeTime(date ?? ''),
          remoteUrl
        }
      })
      .filter((e) => e.hash)
  } catch {
    return []
  }
}

export async function getCommitFeed(repoPaths: string[]): Promise<CommitFeed> {
  const [availability, perRepo] = await Promise.all([
    checkAvailability(),
    Promise.all(repoPaths.map(repoEntries))
  ])

  const allEntries = perRepo.flat()
  allEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const entries = allEntries.slice(0, 40)

  // Kick off background summarization without blocking the response
  if (availability.available && !summarizationRunning) {
    summarizationRunning = true
    runSummarization(entries).finally(() => {
      summarizationRunning = false
    })
  }

  return {
    entries,
    aiAvailable: availability.available,
    aiModel: availability.available ? 'Apple Intelligence' : null,
    aiHint: availability.hint
  }
}
