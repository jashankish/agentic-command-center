import { simpleGit } from 'simple-git'
import { basename } from 'path'
import type { Standup, StandupRepo, StandupCommit } from '../shared/types'

// Unit-separator byte: emitted by git via %x1f, split on in JS. Won't appear in
// hashes, subjects, or dates, so it parses cleanly.
const SEP = String.fromCharCode(0x1f)

function relativeTime(date: string): string {
  const then = new Date(date).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  const h = Math.floor(s / 3600)
  if (h < 1) return `${Math.floor(s / 60)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

async function repoCommits(repoPath: string, sinceIso: string): Promise<StandupRepo | null> {
  try {
    const git = simpleGit(repoPath)
    if (!(await git.checkIsRepo())) return null

    let author = ''
    try {
      author = (await git.raw(['config', 'user.email'])).trim()
    } catch {
      // no configured email — fall back to all authors
    }

    const args = [
      'log',
      `--since=${sinceIso}`,
      '--pretty=format:%h%x1f%s%x1f%aI',
      '--no-merges'
    ]
    if (author) args.push(`--author=${author}`)
    const out = await git.raw(args)

    const commits: StandupCommit[] = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [hash, message, date] = line.split(SEP)
        return { hash, message, relative: relativeTime(date) }
      })

    if (commits.length === 0) return null
    return { path: repoPath, name: basename(repoPath), commits }
  } catch {
    return null
  }
}

/** Gather the user's commits across all repos since `sinceIso` for a standup digest. */
export async function getStandup(repoPaths: string[], sinceIso: string): Promise<Standup> {
  const results = await Promise.all(repoPaths.map((p) => repoCommits(p, sinceIso)))
  const repos = results.filter((r): r is StandupRepo => r !== null)
  const totalCommits = repos.reduce((n, r) => n + r.commits.length, 0)
  return { since: sinceIso, repos, totalCommits, claudeCost: 0 }
}
