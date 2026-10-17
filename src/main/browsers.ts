import { execFile } from 'child_process'
import { basename } from 'path'

/**
 * Chromium browsers throttle windows macOS reports as hidden — and with the
 * lid closed, every window is hidden — so a browser-driven agent (or any web
 * app left working) stalls. Two launch flags turn that off. This detects
 * running Chromium browsers that lack them and, on request, relaunches one
 * with them, carrying over the profile arguments.
 *
 * Relaunching quits the browser, so it is never automatic: the caller
 * confirms first. If the browser won't quit within 10 s nothing is launched —
 * a second copy beside the first would be worse than a throttled one.
 */

export const UNTHROTTLE_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding'
]

const KNOWN_BROWSERS = [
  'com.google.Chrome',
  'org.chromium.Chromium',
  'company.thebrowser.Browser', // Arc
  'ai.perplexity.comet'
]

const QUIT_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 5_000

export interface ThrottledBrowser {
  bundleId: string
  name: string
}

function run(file: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }))
  })
}

/** ACC_EXTRA_BROWSERS (comma-separated bundle ids) adds test stand-ins. */
function browserIds(): string[] {
  const extra = (process.env.ACC_EXTRA_BROWSERS ?? '').split(',').map((s) => s.trim())
  return [...KNOWN_BROWSERS, ...extra.filter((id) => /^[A-Za-z0-9.-]+$/.test(id))]
}

async function runningPid(bundleId: string): Promise<number | null> {
  const r = await run('/usr/bin/lsappinfo', ['info', '-only', 'pid', bundleId], 5000)
  const m = /"pid"\s*=\s*(\d+)/.exec(r.stdout)
  return m ? Number(m[1]) : null
}

async function bundleName(bundleId: string): Promise<string> {
  const r = await run('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath', bundleId], 5000)
  const path = /"LSBundlePath"="([^"]+)"/.exec(r.stdout)?.[1]
  return path ? basename(path, '.app') : bundleId
}

/** Full argument line and start time of a pid, read together. */
async function procInfo(pid: number): Promise<{ args: string; startedAt: string } | null> {
  const args = await run('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], 5000)
  const start = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 5000)
  const a = args.stdout.trim()
  const s = start.stdout.trim().replace(/\s+/g, ' ')
  return a && s ? { args: a, startedAt: s } : null
}

const hasFlag = (args: string, flag: string): boolean =>
  new RegExp(`(^|\\s)${flag}(=|\\s|$)`).test(args)

export const isUnthrottled = (args: string): boolean => UNTHROTTLE_FLAGS.every((f) => hasFlag(args, f))

/** `--user-data-dir=` / `--profile-directory=` so the same profile reopens. */
function preservedArgs(args: string): string[] {
  return args.match(/--(?:user-data-dir|profile-directory)=\S+/g) ?? []
}

/** Running Chromium browsers missing either unthrottling flag. */
export async function scanThrottledBrowsers(): Promise<ThrottledBrowser[]> {
  const out: ThrottledBrowser[] = []
  for (const bundleId of browserIds()) {
    const pid = await runningPid(bundleId)
    if (pid === null) continue
    const info = await procInfo(pid)
    if (info && !isUnthrottled(info.args)) out.push({ bundleId, name: await bundleName(bundleId) })
  }
  return out
}

/** Quit a throttled browser and reopen it with the unthrottling flags.
 *  Returns null on success or a sentence saying why nothing (more) happened. */
export async function relaunchUnthrottled(bundleId: string): Promise<string | null> {
  if (!browserIds().includes(bundleId)) return 'That app is not a supported browser.'
  const name = await bundleName(bundleId)
  const pid = await runningPid(bundleId)
  if (pid === null) return `${name} is not running, so nothing was relaunched.`
  const before = await procInfo(pid)
  if (!before) return `${name}'s launch arguments couldn't be read, so it was left running.`
  // Read twice around the args so they're tied to this exact process.
  const again = await procInfo(pid)
  if (!again || again.startedAt !== before.startedAt) {
    return `${name} changed while its arguments were read, so it was left running.`
  }
  const extra = preservedArgs(before.args)

  await run('/usr/bin/osascript', ['-e', `tell application id "${bundleId}" to quit`], QUIT_TIMEOUT_MS)
  const deadline = Date.now() + QUIT_TIMEOUT_MS
  while ((await runningPid(bundleId)) !== null) {
    if (Date.now() > deadline) {
      return `${name} hadn't quit after 10 s, so nothing was launched. It will need reopening by hand once it closes.`
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  const opened = await run('/usr/bin/open', ['-b', bundleId, '--args', ...UNTHROTTLE_FLAGS, ...extra], 15_000)
  if (!opened.ok) return `${name} quit but couldn't be reopened — open it by hand.`
  const startBy = Date.now() + START_TIMEOUT_MS
  while ((await runningPid(bundleId)) === null) {
    if (Date.now() > startBy) return `${name} was asked to reopen but isn't running after 5 s.`
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}
