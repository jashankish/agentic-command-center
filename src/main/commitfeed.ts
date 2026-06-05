import { spawn } from 'child_process'
import { simpleGit } from 'simple-git'
import { basename } from 'path'
import type { CommitFeed, CommitFeedEntry } from '../shared/types'
import { webUrlFromRemote } from './git'

const SEP = String.fromCharCode(0x1f)

// In-memory session cache: hash → AI summary
const summaryCache = new Map<string, string>()

// Cached model detection: undefined = not yet checked, null = unavailable
let detectedModel: string | null | undefined = undefined
let summarizationRunning = false

function spawnOllama(args: string[]): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('ollama', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.on('close', (code) => resolve({ stdout: out, ok: code === 0 }))
    child.on('error', () => resolve({ stdout: '', ok: false }))
    setTimeout(() => {
      child.kill()
      resolve({ stdout: out, ok: false })
    }, 4000)
  })
}

async function detectOllamaModel(): Promise<string | null> {
  const { stdout, ok } = await spawnOllama(['list'])
  if (!ok) return null

  const lines = stdout.split('\n').slice(1).filter(Boolean)
  if (lines.length === 0) return null

  // Prefer smaller/faster models for summarization
  const preferred = [
    'qwen2.5:3b',
    'qwen2.5:1.5b',
    'llama3.2:3b',
    'llama3.2:1b',
    'phi3:mini',
    'phi3',
    'llama3.2',
    'gemma2:2b',
    'mistral:7b',
    'mistral'
  ]
  for (const pref of preferred) {
    if (lines.some((l) => l.toLowerCase().startsWith(pref.toLowerCase()))) return pref
  }
  const first = lines[0].trim().split(/\s+/)[0]
  return first || null
}

async function getModel(): Promise<string | null> {
  if (detectedModel === undefined) {
    detectedModel = await detectOllamaModel()
  }
  return detectedModel
}

function summarizeWithOllama(model: string, message: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt =
      `Summarize this git commit for a developer activity feed in one clear, ` +
      `specific sentence. Output only the sentence.\n\nCommit: "${message}"\n\nSummary:`

    const child = spawn('ollama', ['run', model], { stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    let settled = false

    const finish = (result: string): void => {
      if (settled) return
      settled = true
      resolve(result.trim() || message)
    }

    child.stdout.on('data', (d: Buffer) => {
      output += d.toString()
    })
    child.stdin.write(prompt)
    child.stdin.end()
    child.on('close', () => finish(output))
    child.on('error', () => finish(message))
    setTimeout(() => {
      child.kill()
      finish(output || message)
    }, 10000)
  })
}

async function runSummarization(entries: CommitFeedEntry[], model: string): Promise<void> {
  const uncached = entries.filter((e) => !summaryCache.has(e.hash))
  // Process sequentially to avoid hammering the local LLM
  for (const e of uncached.slice(0, 15)) {
    const summary = await summarizeWithOllama(model, e.message)
    summaryCache.set(e.hash, summary)
    e.summary = summary
  }
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
        const cached = summaryCache.get(hash ?? '')
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
  const model = await getModel()

  const allEntries = (await Promise.all(repoPaths.map(repoEntries))).flat()
  allEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const entries = allEntries.slice(0, 40)

  // Kick off background summarization without blocking the response
  if (model && !summarizationRunning) {
    summarizationRunning = true
    runSummarization(entries, model).finally(() => {
      summarizationRunning = false
    })
  }

  return { entries, aiAvailable: model !== null, aiModel: model }
}
