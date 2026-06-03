import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Inbox, GithubNotification, MyPr, CheckState } from '../shared/types'
import { resolveGh, ghEnv } from './gh'
import { redactError } from './redact'

const execFileAsync = promisify(execFile)

// Notifications + cross-repo PRs change slowly; cache to stay under rate limits.
const CACHE_MS = 120_000
let cache: { at: number; value: Inbox } | null = null
let inflight: Promise<Inbox> | null = null

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(resolveGh(), args, {
    env: ghEnv(),
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout
}

/** Turn a notifications API subject URL into a browsable html URL. */
function htmlUrl(apiUrl: string | null): string | null {
  if (!apiUrl) return null
  const m = apiUrl.match(/repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d+)/)
  if (!m) return null
  const kind = m[3] === 'pulls' ? 'pull' : 'issues'
  return `https://github.com/${m[1]}/${m[2]}/${kind}/${m[4]}`
}

interface RawNotification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  repository: { full_name: string }
  subject: { title: string; type: string; url: string | null }
}

async function fetchNotifications(): Promise<GithubNotification[]> {
  try {
    const raw = JSON.parse(await gh(['api', 'notifications', '--cache', '0'])) as RawNotification[]
    return raw.slice(0, 30).map((n) => ({
      id: n.id,
      repo: n.repository?.full_name ?? '',
      title: n.subject?.title ?? '(no title)',
      type: n.subject?.type ?? '',
      reason: n.reason ?? '',
      unread: !!n.unread,
      updatedAt: n.updated_at ?? '',
      url: htmlUrl(n.subject?.url ?? null)
    }))
  } catch {
    return []
  }
}

interface RawPr {
  number: number
  title: string
  url: string
  isDraft: boolean
  reviewDecision: string | null
  updatedAt: string
  repository: { nameWithOwner: string }
  statusCheckRollup?: Array<{ state?: string; conclusion?: string; status?: string }>
}

function rollupToChecks(rollup: RawPr['statusCheckRollup']): CheckState {
  if (!rollup || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    // StatusContext uses `state` (SUCCESS/FAILURE/PENDING); CheckRun uses
    // `status` (COMPLETED/IN_PROGRESS) + `conclusion` (SUCCESS/FAILURE/…).
    const state = (c.state ?? c.conclusion ?? '').toUpperCase()
    const status = (c.status ?? '').toUpperCase()
    if (status && status !== 'COMPLETED') pending = true
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(state)) {
      return 'fail'
    } else if (state === 'PENDING' || state === 'EXPECTED' || state === '') pending = true
  }
  return pending ? 'pending' : 'pass'
}

async function fetchMyPrs(): Promise<MyPr[]> {
  try {
    const raw = JSON.parse(
      await gh([
        'search',
        'prs',
        '--author',
        '@me',
        '--state',
        'open',
        '-L',
        '30',
        '--json',
        'number,title,url,isDraft,reviewDecision,updatedAt,repository,statusCheckRollup'
      ])
    ) as RawPr[]
    return raw.map((p) => ({
      repo: p.repository?.nameWithOwner ?? '',
      number: p.number,
      title: p.title,
      url: p.url,
      draft: !!p.isDraft,
      reviewDecision: p.reviewDecision ?? '',
      checks: rollupToChecks(p.statusCheckRollup),
      updatedAt: p.updatedAt
    }))
  } catch {
    return []
  }
}

async function compute(): Promise<Inbox> {
  try {
    // A cheap probe so we can distinguish "gh missing/unauthed" (unavailable)
    // from "authed but empty inbox" (available, zero items).
    await gh(['api', 'user', '-q', '.login'])
  } catch (err) {
    return { notifications: [], prs: [], available: false, error: redactError(err) }
  }
  const [notifications, prs] = await Promise.all([fetchNotifications(), fetchMyPrs()])
  return { notifications, prs, available: true }
}

export async function getInbox(): Promise<Inbox> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight
  inflight = compute()
    .then((value) => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
