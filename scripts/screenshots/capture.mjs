// Regenerates every screenshot in docs/ from the fake dataset in mock-data.mjs.
//
// It builds the real renderer bundle, serves it over http, injects a mock
// `window.api` (so no git/gh/Claude/AppleScript is touched and no personal data
// can appear), then drives headless Chromium to screenshot each surface.
//
//   node scripts/screenshots/capture.mjs      (or: npm run screenshots)
//
// Prerequisites: `playwright-core` (devDependency) and a Chromium build, which
// you install once with `npx playwright install chromium`. See README.md here.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { resolve, extname, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { buildData } from './mock-data.mjs'

const require = createRequire(import.meta.url)
let chromium
try {
  ;({ chromium } = require('playwright-core'))
} catch {
  console.error('✗ playwright-core is not installed.\n  npm i -D playwright-core && npx playwright install chromium')
  process.exit(1)
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RENDERER = join(ROOT, 'src', 'renderer')
const OUT = join(ROOT, 'out', '.shots', 'renderer') // gitignored build dir
const DOCS = join(ROOT, 'docs')

// Injected before any page script runs: a complete fake `window.api`. Every
// method the renderer can call must exist here and resolve, or a surface won't
// render. Event subscriptions return an unsubscribe function.
function mockApiScript(data) {
  return `
window.api = (function () {
  const D = ${JSON.stringify(data)};
  const ok = { success: true };
  let viewMode = D.viewMode, meta = D.repoMeta, prefs = D.panelPrefs;
  const noop = () => {}, sub = () => noop;
  return {
    listRepos: async () => D.repos.map(r => r.path),
    getStatus: async (p) => D.status[p],
    getScripts: async (p) => ({ path: p, scripts: D.scripts[p] || [] }),
    getInsights: async (p) => D.insights[p],
    getClaudeActivity: async () => D.claude,
    getUsage: async () => D.usage,
    getContributions: async () => D.contrib,
    getInbox: async () => D.inbox,
    getSystemStats: async () => D.system,
    getCalendar: async () => D.calendar,
    listDevServers: async () => D.devServers,
    getStandup: async () => D.standup,
    getCommitFeed: async () => D.commitFeed,
    getTerminals: async () => D.terminals,
    getAgentTimeline: async () => D.timeline,
    getHooksStatus: async () => D.hooks,
    getPanelPrefs: async () => prefs,
    setPanelPrefs: async (patch) => (prefs = Object.assign({}, prefs, patch)),
    installHooks: async (d) => Object.assign({}, D.hooks, { installed: true, detailed: !!d }),
    uninstallHooks: async () => Object.assign({}, D.hooks, { installed: false, detailed: false, partial: false }),
    getRepoMeta: async () => meta,
    setRepoMeta: async (p, patch) => (meta = Object.assign({}, meta, { [p]: Object.assign({}, meta[p], patch) })),
    getViewMode: async () => viewMode,
    setViewMode: async (m) => (viewMode = m),
    isPinned: async () => true,
    togglePin: async () => true,
    toggleFeed: async () => false,
    toggleTerminals: async () => false,
    onFeedClosed: sub, onTerminalsClosed: sub, onSessionsUpdate: sub,
    setBadge: async () => {},
    launchAgent: async () => ok,
    pickDirectory: async () => [],
    scanForRepos: async () => [],
    addRepo: async () => {}, removeRepo: async () => {},
    exportSettings: async () => ok, importSettings: async () => ok,
    commitPush: async () => ok, fetchRepo: async () => ok,
    focusTerminal: async () => ok, activateHostApp: async () => ok,
    openEditor: async () => ok, openTerminal: async () => ok, reveal: async () => ok, openRemote: async () => ok,
    runScript: async () => ok
  };
})();`
}

// Capture-only overrides: a solid backdrop in place of the live vibrancy, let
// the scrollable panels flow to full height, and hide the hover tooltip helper.
const captureCss = `
  html, body, #root { height: auto !important; min-height: 0 !important; overflow: visible !important; background: #14161b !important; }
  .app { height: auto !important; }
  .cards-scroll { overflow: visible !important; flex: none !important; }
  .feed-window, .term-window { height: auto !important; min-height: 0 !important; }
  .feed-body, .term-body { overflow: visible !important; flex: none !important; }
  .info-scroll, .standup-body { max-height: none !important; overflow: visible !important; flex: none !important; }
  .dialog, .dialog-info, .dialog-wide { max-height: none !important; }
  #tt { display: none !important; }
`

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon' }

// Each surface to capture. `element` clips to a node; `clipTo` clips from the
// top down to a node's bottom; otherwise the full page is captured.
const SHOTS = [
  { file: 'screenshot.png', width: 760, waitFor: '.card .card-name' },
  { file: 'screenshot-compact-view.png', width: 760, waitFor: '.card', clipTo: 'footer.summary',
    prep: async (p) => { await p.click('button[title="Switch to compact view"]'); await p.waitForSelector('footer.summary') } },
  { file: 'screenshot-command-palette.png', width: 760, waitFor: '.card', element: '.palette',
    prep: async (p) => { await p.click('button[title="Command palette (⌘K)"]'); await p.waitForSelector('.palette-input') } },
  { file: 'screenshot-standup.png', width: 760, waitFor: '.card', element: '.dialog-wide',
    prep: async (p) => { await p.click('button[title="Standup digest"]'); await p.waitForSelector('.standup-repo') } },
  { file: 'screenshot-info.png', width: 760, waitFor: '.card', element: '.dialog-info',
    prep: async (p) => { await p.click('button[title="What everything means"]'); await p.waitForSelector('.info-scroll') } },
  { file: 'screenshot-activity-feed.png', width: 320, hash: '#feed', waitFor: '.feed-entry', element: '.feed-window' },
  { file: 'screenshot-terminals.png', width: 360, hash: '#terminals', waitFor: '.term-entry', element: '.term-window' },
  { file: 'screenshot-terminals-events.png', width: 360, hash: '#terminals', waitFor: '.term-entry', element: '.term-window',
    prep: async (p) => { await p.click('button.term-tab >> text=Events'); await p.waitForSelector('.tl-entry') } }
]

async function main() {
  console.log('› building renderer…')
  await build({
    root: RENDERER, base: './', plugins: [react()], logLevel: 'warn',
    build: { outDir: OUT, emptyOutDir: true, chunkSizeWarningLimit: 5000 }
  })

  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0].split('#')[0])
      if (p === '/' || p === '') p = '/index.html'
      const body = await readFile(join(OUT, p))
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, r))
  const base = `http://localhost:${server.address().port}/index.html`
  console.log('› serving on', server.address().port)

  const data = buildData()
  const initJs = mockApiScript(data)
  const browser = await chromium.launch({ headless: true })

  for (const s of SHOTS) {
    const ctx = await browser.newContext({ viewport: { width: s.width, height: 1000 }, deviceScaleFactor: 2 })
    await ctx.addInitScript(initJs)
    const page = await ctx.newPage()
    await page.goto(base + (s.hash || ''), { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: captureCss })
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 15000 })
    if (s.prep) await s.prep(page)
    await page.mouse.move(2, 2)
    await page.waitForTimeout(400)

    const out = join(DOCS, s.file)
    if (s.element) {
      await page.locator(s.element).first().screenshot({ path: out })
    } else if (s.clipTo) {
      const b = await page.locator(s.clipTo).first().boundingBox()
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: s.width, height: Math.ceil(b.y + b.height + 14) } })
    } else {
      await page.screenshot({ path: out, fullPage: true })
    }
    console.log('  ✓', s.file)
    await ctx.close()
  }

  await browser.close()
  server.close()
  console.log('› done — wrote', SHOTS.length, 'screenshots to docs/')
}

main().catch((e) => { console.error(e); process.exit(1) })
