import { simpleGit } from 'simple-git'
import { basename } from 'path'
import type { RepoStatus, CommitPushResult } from '../shared/types'
import { redactError } from './redact'

/** Compact "time ago" label from an ISO/RFC date string. */
function relativeTime(date: string): string {
  const then = new Date(date).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

/** Turn an SSH/HTTPS git remote into a browsable https URL, or null. */
export function webUrlFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null
  const s = remote.trim()
  // scp-style: git@github.com:owner/repo(.git)
  const ssh = s.match(/^[\w.-]+@([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  const url = s.replace(/^ssh:\/\/[\w.-]+@/, 'https://').replace(/\.git$/, '')
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return null
}

/** Parse owner/repo from a github remote, or null when it isn't one. */
export function ownerRepoFromRemote(
  remote: string | null | undefined
): { owner: string; repo: string } | null {
  const web = webUrlFromRemote(remote)
  if (!web) return null
  const m = web.match(/github\.com\/([^/]+)\/([^/]+?)(?:\/|$)/)
  return m ? { owner: m[1], repo: m[2] } : null
}

export async function getStatus(repoPath: string): Promise<RepoStatus> {
  const base: RepoStatus = {
    path: repoPath,
    name: basename(repoPath),
    branch: null,
    ahead: 0,
    behind: 0,
    changedCount: 0,
    hasUpstream: false,
    changedFiles: [],
    lastCommitRelative: null,
    lastCommitMessage: null,
    remoteUrl: null
  }
  try {
    const git = simpleGit(repoPath)
    const isRepo = await git.checkIsRepo()
    if (!isRepo) {
      return { ...base, error: 'Not a git repository' }
    }
    const status = await git.status()

    // These extras are best-effort — a missing remote or empty history must not
    // turn the whole tile into an error.
    let remoteUrl: string | null = null
    try {
      remoteUrl = webUrlFromRemote((await git.remote(['get-url', 'origin'])) as string)
    } catch {
      // no origin remote
    }
    let lastCommitRelative: string | null = null
    let lastCommitMessage: string | null = null
    try {
      const log = await git.log({ maxCount: 1 })
      if (log.latest) {
        lastCommitRelative = relativeTime(log.latest.date)
        lastCommitMessage = log.latest.message
      }
    } catch {
      // no commits yet
    }

    return {
      ...base,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      changedCount: status.files.length,
      hasUpstream: !!status.tracking,
      changedFiles: status.files.map((f) => f.path),
      lastCommitRelative,
      lastCommitMessage,
      remoteUrl
    }
  } catch (err) {
    return { ...base, error: redactError(err) }
  }
}

export async function commitAndPush(
  repoPath: string,
  message: string
): Promise<CommitPushResult> {
  try {
    const git = simpleGit(repoPath)
    const before = await git.status()
    const branch = before.current
    if (!branch) {
      return { success: false, error: 'Detached HEAD — cannot determine a branch to push.' }
    }
    // Stage everything (tracked + untracked) and commit only if the tree is dirty.
    if (before.files.length > 0) {
      await git.add('.')
      await git.commit(message)
    }
    // Push the current branch, setting upstream on first push.
    if (before.tracking) {
      await git.push()
    } else {
      await git.push(['-u', 'origin', branch])
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: redactError(err) }
  }
}

/** Fetch from origin so ahead/behind counts reflect the remote. */
export async function fetchRepo(repoPath: string): Promise<CommitPushResult> {
  try {
    await simpleGit(repoPath).fetch()
    return { success: true }
  } catch (err) {
    return { success: false, error: redactError(err) }
  }
}
