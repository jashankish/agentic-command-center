import { execFile } from 'child_process'
import { promisify } from 'util'
import { simpleGit } from 'simple-git'
import type { RepoInsights, CiState } from '../shared/types'
import { resolveGh, ghEnv } from './gh'
import { ownerRepoFromRemote } from './git'
import { redactError } from './redact'

const execFileAsync = promisify(execFile)

// GitHub data moves slowly and the API is rate-limited, so cache generously per
// repo and let the renderer poll on a slow timer.
const CACHE_MS = 300_000
const cache = new Map<string, { at: number; value: RepoInsights }>()

// The signed-in login, cached an hour, used to flag PRs that request our review.
let login: string | null = null
let loginAt = 0

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGh(), args, {
    env: ghEnv(),
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
}

async function getLogin(): Promise<string | null> {
  if (login && Date.now() - loginAt < 3_600_000) return login
  try {
    login = (await gh(['api', 'user', '-q', '.login'])).trim() || null
    loginAt = Date.now()
  } catch {
    login = null
  }
  return login
}

async function fetchCi(slug: string): Promise<CiState> {
  try {
    const runs = JSON.parse(
      await gh(['run', 'list', '-R', slug, '-L', '1', '--json', 'status,conclusion'])
    ) as Array<{ status: string; conclusion: string | null }>
    if (!runs.length) return 'none'
    const r = runs[0]
    if (r.status !== 'completed') return 'pending'
    if (r.conclusion === 'success') return 'pass'
    if (['failure', 'timed_out', 'startup_failure', 'cancelled'].includes(r.conclusion ?? '')) {
      return 'fail'
    }
    return 'none'
  } catch {
    return 'none'
  }
}

async function fetchPrs(slug: string, me: string | null): Promise<{ open: number; review: number }> {
  try {
    const prs = JSON.parse(
      await gh(['pr', 'list', '-R', slug, '--state', 'open', '-L', '50', '--json', 'reviewRequests'])
    ) as Array<{ reviewRequests?: Array<{ login?: string }> }>
    const review = me
      ? prs.filter((p) => p.reviewRequests?.some((rr) => rr.login === me)).length
      : 0
    return { open: prs.length, review }
  } catch {
    return { open: 0, review: 0 }
  }
}

async function fetchIssues(slug: string): Promise<number> {
  try {
    const issues = JSON.parse(
      await gh(['issue', 'list', '-R', slug, '--assignee', '@me', '--state', 'open', '-L', '50', '--json', 'number'])
    ) as unknown[]
    return issues.length
  } catch {
    return 0
  }
}

export async function getInsights(repoPath: string): Promise<RepoInsights> {
  const cached = cache.get(repoPath)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value

  const unavailable: RepoInsights = {
    path: repoPath,
    ci: 'none',
    openPRs: 0,
    reviewRequests: 0,
    assignedIssues: 0,
    available: false
  }

  let value = unavailable
  try {
    let remote: string | null = null
    try {
      remote = (await simpleGit(repoPath).remote(['get-url', 'origin'])) as string
    } catch {
      // no origin
    }
    const or = ownerRepoFromRemote(remote)
    if (or) {
      const slug = `${or.owner}/${or.repo}`
      const me = await getLogin()
      const [ci, prs, assignedIssues] = await Promise.all([
        fetchCi(slug),
        fetchPrs(slug, me),
        fetchIssues(slug)
      ])
      value = {
        path: repoPath,
        ci,
        openPRs: prs.open,
        reviewRequests: prs.review,
        assignedIssues,
        available: true
      }
    }
  } catch (err) {
    value = { ...unavailable, error: redactError(err) }
  }

  cache.set(repoPath, { at: Date.now(), value })
  return value
}
