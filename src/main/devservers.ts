import { execFile } from 'child_process'
import { accessSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import type { DevServer, RepoScripts } from '../shared/types'

const execFileAsync = promisify(execFile)

// Only resolve the working directory for processes that look like dev servers,
// to avoid an lsof call per unrelated system listener.
const DEV_COMMAND = /node|npm|pnpm|yarn|bun|deno|vite|next|webpack|esbuild|rollup|python|ruby|rails|puma|php|cargo|air|gunicorn|uvicorn/i

const CACHE_MS = 8000
let cache: { at: number; value: RawServer[] } | null = null

interface RawServer {
  pid: number
  command: string
  port: number
  cwd: string
}

function resolveLsof(): string {
  for (const c of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return 'lsof'
}

function portOf(name: string): number | null {
  // e.g. "*:3000", "127.0.0.1:5173", "[::1]:8080"
  const m = name.match(/:(\d+)$/)
  if (!m) return null
  const port = Number(m[1])
  return port > 0 ? port : null
}

async function cwdOf(lsof: string, pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}

async function scan(): Promise<RawServer[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const lsof = resolveLsof()

  let stdout = ''
  try {
    ;({ stdout } = await execFileAsync(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], {
      maxBuffer: 4 * 1024 * 1024
    }))
  } catch {
    return []
  }

  // -F pcn output: a "p<pid>" line starts a process record, "c<command>" names
  // it, and each following "n<host:port>" is one listening socket.
  const listeners: Array<{ pid: number; command: string; port: number }> = []
  let pid = 0
  let command = ''
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const rest = line.slice(1)
    if (tag === 'p') pid = Number(rest) || 0
    else if (tag === 'c') command = rest
    else if (tag === 'n') {
      const port = portOf(rest)
      if (port && DEV_COMMAND.test(command)) listeners.push({ pid, command, port })
    }
  }

  // Resolve cwd once per unique pid.
  const cwds = new Map<number, string | null>()
  await Promise.all(
    [...new Set(listeners.map((l) => l.pid))].map(async (p) => {
      cwds.set(p, await cwdOf(lsof, p))
    })
  )

  const seen = new Set<string>()
  const servers: RawServer[] = []
  for (const l of listeners) {
    const cwd = cwds.get(l.pid)
    if (!cwd) continue
    const key = `${l.pid}:${l.port}`
    if (seen.has(key)) continue
    seen.add(key)
    servers.push({ pid: l.pid, command: l.command, port: l.port, cwd })
  }

  cache = { at: Date.now(), value: servers }
  return servers
}

/** List dev servers whose working directory belongs to one of the given repos. */
export async function listDevServers(repoPaths: string[]): Promise<DevServer[]> {
  const raw = await scan()
  const out: DevServer[] = []
  for (const s of raw) {
    const repoPath = repoPaths.find((r) => s.cwd === r || s.cwd.startsWith(r + '/'))
    if (repoPath) out.push({ ...s, repoPath })
  }
  return out.sort((a, b) => a.port - b.port)
}

/** Read the npm script names declared in a repo's package.json. */
export async function getScripts(repoPath: string): Promise<RepoScripts> {
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return { path: repoPath, scripts: Object.keys(pkg.scripts ?? {}) }
  } catch {
    return { path: repoPath, scripts: [] }
  }
}
