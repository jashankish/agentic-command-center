// Fake, PII-free dataset that backs every README screenshot.
//
// This is the file to edit when a feature changes what a panel shows. It is the
// single source of truth handed to the injected `window.api` (see capture.mjs),
// so every value here is something a real user would see — only invented. Keep
// it that way: no real repo paths, project names, commit messages, or people.
//
// Repos live under a fictional `/Users/dev/...` tree and a `northwind` GitHub org.
// Timestamps are relative to "now" so the panels always look freshly loaded.

const ago = (ms) => new Date(Date.now() - ms).toISOString()
const ahead = (ms) => new Date(Date.now() + ms).toISOString()
const MIN = 60_000
const HR = 60 * MIN
const gh = (n) => `https://github.com/northwind/${n}`

// One row per imported repo. `group`/`fav` drive the dashboard's grouped
// sections; the git/CI/cost fields drive the cards, health bar, and panels.
const repoSpecs = [
  { name: 'acme-dashboard', dir: '/Users/dev/code/acme-dashboard', group: 'Client', fav: true,
    branch: 'main', age: '2h ago', ahead: 0, behind: 0, changed: 0, upstream: true,
    msg: 'Wire up the quarterly revenue chart endpoint', files: [],
    ci: 'pass', prs: 2, review: 1, issues: 0,
    cToday: 18.40, cWeek: 92.30, cTotal: 315.50, sessions: 12, active: true },
  { name: 'design-system', dir: '/Users/dev/code/design-system', group: 'Client', fav: false,
    branch: 'main', age: '5h ago', ahead: 0, behind: 0, changed: 0, upstream: true,
    msg: 'Refactor color token scale for dark mode', files: [],
    ci: 'pass', prs: 1, review: 0, issues: 0,
    cToday: 6.20, cWeek: 40.10, cTotal: 128.90, sessions: 6, active: false },
  { name: 'marketing-site', dir: '/Users/dev/code/marketing-site', group: 'Client', fav: false,
    branch: 'main', age: '1d ago', ahead: 1, behind: 0, changed: 0, upstream: true,
    msg: 'Launch new pricing page with comparison table', files: [],
    ci: 'pass', prs: 3, review: 1, issues: 0,
    cToday: 7.20, cWeek: 31.50, cTotal: 96.40, sessions: 4, active: false },
  { name: 'mobile-app', dir: '/Users/dev/code/mobile-app', group: 'Client', fav: false,
    branch: 'feature/haptics', age: '32m ago', ahead: 2, behind: 0, changed: 4, upstream: true,
    msg: 'Implement haptic feedback for swipe-to-refresh', ci: 'fail', prs: 1, review: 0, issues: 1,
    files: ['src/gestures/SwipeRefresh.tsx', 'src/haptics/engine.ts', 'src/screens/Feed.tsx', 'ios/Podfile.lock'],
    cToday: 60.50, cWeek: 180.20, cTotal: 860.50, sessions: 9, active: false },
  { name: 'data-pipeline', dir: '/Users/dev/work/data-pipeline', group: 'Internal', fav: false,
    branch: 'main', age: '3h ago', ahead: 0, behind: 0, changed: 1, upstream: true,
    msg: 'Fix Kafka consumer reconnect backoff', files: ['ingest/consumer.py'],
    ci: 'fail', prs: 1, review: 0, issues: 1,
    cToday: 58.04, cWeek: 120.00, cTotal: 540.00, sessions: 7, active: false },
  { name: 'internal-tools', dir: '/Users/dev/work/internal-tools', group: 'Internal', fav: false,
    branch: 'main', age: '2d ago', ahead: 0, behind: 0, changed: 0, upstream: false,
    msg: 'Add audit log viewer to the admin console', files: [],
    ci: 'none', prs: 1, review: 0, issues: 0, available: true,
    cToday: 2.10, cWeek: 12.00, cTotal: 60.00, sessions: 2, active: false },
  { name: 'ml-experiments', dir: '/Users/dev/lab/ml-experiments', group: 'Internal', fav: false,
    branch: 'train/resnet', age: '6h ago', ahead: 2, behind: 0, changed: 0, upstream: true,
    msg: 'Train ResNet variant on extended image dataset', files: [],
    ci: 'pending', prs: 0, review: 0, issues: 0,
    cToday: 31.00, cWeek: 90.00, cTotal: 420.00, sessions: 5, active: false },
  { name: 'payments-api', dir: '/Users/dev/work/payments-api', group: 'Internal', fav: true,
    branch: 'main', age: '45m ago', ahead: 2, behind: 0, changed: 0, upstream: true,
    msg: 'Add idempotency keys to the Stripe webhook handler', files: [],
    ci: 'pass', prs: 2, review: 1, issues: 0,
    cToday: 30.60, cWeek: 110.00, cTotal: 980.00, sessions: 8, active: false }
]

// ~1 year of contributions with a believable recent streak (today may be empty,
// the prior 12 days active, then a gap) so the "🔥 N-day streak" readout shows.
function genContrib() {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const start = new Date(today); start.setDate(start.getDate() - 364)
  start.setDate(start.getDate() - start.getDay()) // align to Sunday
  const days = []
  for (let c = new Date(start); c <= today; c.setDate(c.getDate() + 1)) {
    const r = Math.random()
    const level = r < 0.34 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 2 : r < 0.93 ? 3 : 4
    const count = level === 0 ? 0 : level * (2 + Math.floor(Math.random() * 6))
    days.push({ date: new Date(c).toISOString().slice(0, 10), count, level, weekday: c.getDay() })
  }
  const n = days.length
  days[n - 1].count = 0; days[n - 1].level = 0
  for (let i = n - 2; i >= n - 13; i--) { days[i].level = 2 + Math.floor(Math.random() * 3); days[i].count = days[i].level * 4 }
  days[n - 14].count = 0; days[n - 14].level = 0
  const weeks = []; let wk = []
  for (const d of days) { wk.push(d); if (d.weekday === 6) { weeks.push(wk); wk = [] } }
  if (wk.length) weeks.push(wk)
  return { total: 1312, weeks }
}

const feedEntry = (repo, summary, message, author, rel, dms, hash) => ({
  repoPath: repoSpecs.find((r) => r.name === repo).dir, repoName: repo, hash,
  message, summary, author, date: ago(dms), relative: rel, remoteUrl: gh(repo)
})

const dirOf = (n) => repoSpecs.find((r) => r.name === n).dir
const agentState = (o) => ({
  sessionId: o.sid, state: o.state, confidence: o.conf || 'event', since: o.since,
  detail: o.detail, model: o.model, permissionMode: o.mode || 'default',
  title: o.title, lastPrompt: o.prompt, pid: o.pid, tty: o.tty, cwd: o.cwd, repoPath: o.repo,
  automation: o.automation
})
const terminalEntry = (o) => ({
  app: o.app, windowId: o.win, tabIndex: o.tab, tty: o.tty, title: o.title,
  command: o.cmd, cwd: o.cwd, repoPath: o.repo, busy: o.busy, agent: o.agent || null, tmux: o.tmux
})
const tlEvent = (kind, sid, repo, dms, extra) =>
  Object.assign({ ts: ago(dms), sessionId: sid, kind, cwd: repo, repoPath: repo }, extra || {})

/** Build the full snapshot of fake data backing every panel. */
export function buildData() {
  const status = {}, insights = {}, scripts = {}, repoMeta = {}, claudeProjects = []
  for (const r of repoSpecs) {
    status[r.dir] = {
      path: r.dir, name: r.name, branch: r.branch, ahead: r.ahead, behind: r.behind,
      changedCount: r.changed, hasUpstream: r.upstream, changedFiles: r.files,
      lastCommitRelative: r.age, lastCommitMessage: r.msg, remoteUrl: gh(r.name)
    }
    insights[r.dir] = {
      path: r.dir, ci: r.ci, openPRs: r.prs, reviewRequests: r.review,
      assignedIssues: r.issues, available: r.available ?? true
    }
    scripts[r.dir] = ['dev', 'build', 'test', 'lint']
    repoMeta[r.dir] = { favorite: r.fav, group: r.group }
    claudeProjects.push({
      path: r.dir, costToday: r.cToday, costWeek: r.cWeek, costTotal: r.cTotal,
      tokensToday: Math.round(r.cToday * 90000), sessions: r.sessions,
      lastActivity: ago(r.active ? 2 * MIN : 3 * HR), active: r.active,
      models: { opus: r.cTotal * 0.6, sonnet: r.cTotal * 0.3, haiku: r.cTotal * 0.1, fable: 0, other: 0 }
    })
  }

  return {
    repos: repoSpecs.map((r) => ({ path: r.dir })),
    status, insights, scripts, repoMeta, viewMode: 'dashboard',

    claude: {
      projects: claudeProjects, costToday: 214.04, costWeek: 980.0, costTotal: 4120.0,
      plans: ['auth-flow-redesign', 'payment-webhook-handler', 'mobile-push-notifications',
        'dashboard-metrics-pipeline', 'data-export-service'],
      available: true
    },
    usage: {
      session: { utilization: 14, resetsAt: ahead(2 * HR + 15 * MIN) },
      weekly: { utilization: 41, resetsAt: ahead(4 * 24 * HR) },
      weeklyOpus: { utilization: 23, resetsAt: ahead(4 * 24 * HR) }
    },
    contrib: genContrib(),
    system: { cpu: 21, memUsed: 11.0 * 1024 ** 3, memTotal: 16 * 1024 ** 3, memPercent: 68 },
    calendar: { available: true, events: [{ title: 'Sprint planning', start: ahead(2 * HR), allDay: false }] },
    devServers: [
      { port: 3000, pid: 4101, command: 'next dev', cwd: dirOf('acme-dashboard'), repoPath: dirOf('acme-dashboard') },
      { port: 5173, pid: 4102, command: 'vite', cwd: dirOf('design-system'), repoPath: dirOf('design-system') }
    ],

    inbox: {
      available: true,
      prs: [
        { repo: 'northwind/payments-api', number: 48, title: 'Add idempotency keys to the Stripe webhook handler',
          url: gh('payments-api') + '/pull/48', draft: false, reviewDecision: 'REVIEW_REQUIRED', checks: 'pass', updatedAt: ago(40 * MIN) },
        { repo: 'northwind/acme-dashboard', number: 112, title: 'Add quarterly revenue chart to the overview dashboard',
          url: gh('acme-dashboard') + '/pull/112', draft: false, reviewDecision: 'APPROVED', checks: 'pass', updatedAt: ago(3 * HR) },
        { repo: 'northwind/data-pipeline', number: 57, title: 'Rework consumer reconnect backoff',
          url: gh('data-pipeline') + '/pull/57', draft: true, reviewDecision: 'CHANGES_REQUESTED', checks: 'fail', updatedAt: ago(5 * HR) }
      ],
      notifications: [
        { id: 'n1', repo: 'northwind/payments-api', title: 'Review requested on payments-api #48', type: 'PullRequest', reason: 'review_requested', unread: true, updatedAt: ago(38 * MIN), url: gh('payments-api') + '/pull/48' },
        { id: 'n2', repo: 'northwind/data-pipeline', title: 'CI failed on data-pipeline: main', type: 'CheckSuite', reason: 'ci_activity', unread: true, updatedAt: ago(52 * MIN), url: gh('data-pipeline') + '/actions' },
        { id: 'n3', repo: 'northwind/design-system', title: 'You were mentioned in design-system #23', type: 'Issue', reason: 'mention', unread: false, updatedAt: ago(4 * HR), url: gh('design-system') + '/issues/23' },
        { id: 'n4', repo: 'northwind/mobile-app', title: 'Issue #9 assigned: Audit log viewer', type: 'Issue', reason: 'assign', unread: false, updatedAt: ago(6 * HR), url: gh('mobile-app') + '/issues/9' }
      ]
    },

    commitFeed: {
      aiAvailable: true, aiModel: 'Apple Intelligence',
      entries: [
        feedEntry('design-system', 'Accessible contrast tokens for dark mode', 'feat: add accessible color-contrast tokens for the dark theme', 'Riley Chen', '12m ago', 12 * MIN, '7a1c9e4'),
        feedEntry('acme-dashboard', 'Quarterly revenue chart on overview', 'feat: add quarterly revenue chart to the overview dashboard', 'Riley Chen', '34m ago', 34 * MIN, 'b22f018'),
        feedEntry('marketing-site', 'New pricing page with comparison table', 'feat: launch new pricing page with feature comparison table', 'Sam Ortiz', '47m ago', 47 * MIN, '5d8a6f1'),
        feedEntry('data-pipeline', 'Fix Kafka reconnect memory leak', 'fix: resolve memory leak in Kafka consumer reconnect handler', 'Priya Nair', '1h ago', 70 * MIN, 'c0e3b77'),
        feedEntry('mobile-app', 'Haptics for swipe-to-refresh', 'feat: implement haptic feedback for the swipe-to-refresh gesture', 'Jordan Lee', '1h ago', 78 * MIN, '9f44a20'),
        feedEntry('payments-api', 'Idempotency keys for Stripe webhooks', 'feat: add idempotency keys to Stripe webhook processing', 'Priya Nair', '2h ago', 120 * MIN, 'a8b1d39'),
        feedEntry('internal-tools', 'Onboarding checklist on new admin UI', 'feat: migrate team onboarding checklist to the new admin console', 'Sam Ortiz', '2h ago', 140 * MIN, '3c9e512'),
        feedEntry('data-pipeline', 'Subscription report query 3x faster', 'perf: optimize SQL query for the active-subscription report', 'Priya Nair', '3h ago', 3 * HR, 'd71f8a0'),
        feedEntry('design-system', 'Export Figma tokens to CSS variables', 'chore: export updated Figma tokens to CSS custom properties', 'Riley Chen', '3h ago', 3 * HR + 20 * MIN, '6e2c4b8'),
        feedEntry('ml-experiments', 'ResNet variant on extended dataset', 'feat: train ResNet variant on the extended product image dataset', 'Alex Kim', '4h ago', 4 * HR, 'f0a7c33'),
        feedEntry('mobile-app', 'Cache auth tokens for background refresh', 'feat: cache auth tokens in keychain for background app refresh', 'Jordan Lee', '5h ago', 5 * HR, '2b6d9e1'),
        feedEntry('payments-api', 'Backoff for failed payout retries', 'fix: add exponential backoff for failed Stripe payout retries', 'Priya Nair', '6h ago', 6 * HR, 'e4c1a55'),
        feedEntry('acme-dashboard', 'Skeleton loaders on dashboard cards', 'feat: add skeleton loaders to the dashboard summary cards', 'Riley Chen', '7h ago', 7 * HR, '1a9f7c2'),
        feedEntry('marketing-site', 'Lighthouse pass on landing page', 'perf: improve Lighthouse score on the marketing landing page', 'Sam Ortiz', '8h ago', 8 * HR, '8d3b0a6')
      ]
    },

    standup: {
      since: ago(12 * HR), totalCommits: 8, claudeCost: 214.04,
      repos: [
        { path: dirOf('acme-dashboard'), name: 'acme-dashboard', commits: [
          { hash: 'b22f018', message: 'Add quarterly revenue chart to the overview dashboard', relative: '34m ago' },
          { hash: '1a9f7c2', message: 'Add skeleton loaders to the dashboard summary cards', relative: '7h ago' },
          { hash: 'a30f9c1', message: 'Tidy up the overview header spacing', relative: '9h ago' } ] },
        { path: dirOf('payments-api'), name: 'payments-api', commits: [
          { hash: 'a8b1d39', message: 'Add idempotency keys to Stripe webhook processing', relative: '2h ago' },
          { hash: 'e4c1a55', message: 'Add exponential backoff for failed Stripe payout retries', relative: '6h ago' } ] },
        { path: dirOf('design-system'), name: 'design-system', commits: [
          { hash: '7a1c9e4', message: 'Add accessible color-contrast tokens for dark mode', relative: '12m ago' },
          { hash: '6e2c4b8', message: 'Export updated Figma tokens to CSS custom properties', relative: '3h ago' } ] },
        { path: dirOf('mobile-app'), name: 'mobile-app', commits: [
          { hash: '9f44a20', message: 'Implement haptic feedback for swipe-to-refresh', relative: '1h ago' } ] }
      ]
    },

    terminals: {
      automation: { terminal: 'ok', iterm: 'ok' },
      unbound: [
        // A long-running /loop in a detached tmux session — detected with no
        // hooks (heuristic, dashed badge), still listed between iterations.
        Object.assign(agentState({ sid: 'u1', state: 'working', conf: 'heuristic', since: ago(38 * MIN), model: 'claude-opus-4-8',
          title: 'Keep the pipeline test suite green', prompt: '/loop run the tests and fix any failures until they pass',
          pid: 5221, tty: null, cwd: dirOf('data-pipeline'), repo: dirOf('data-pipeline'), automation: 'loop' }), { host: 'tmux' }),
        // A scheduled (cron) autonomous run that has finished its turn.
        Object.assign(agentState({ sid: 'u3', state: 'input', conf: 'event', since: ago(6 * MIN), model: 'claude-sonnet-4-6',
          title: 'Nightly content + pricing data refresh', prompt: 'Scheduled run',
          pid: 5410, tty: null, cwd: dirOf('marketing-site'), repo: dirOf('marketing-site'), automation: 'cron' }), { host: 'tmux' }),
        Object.assign(agentState({ sid: 'u2', state: 'input', conf: 'heuristic', since: ago(70 * 1000), model: 'claude-sonnet-4-6',
          title: 'Add unit tests for the auth guard', pid: 5333, tty: null, cwd: dirOf('internal-tools'), repo: dirOf('internal-tools') }), { host: 'Cursor' })
      ],
      entries: [
        terminalEntry({ app: 'iTerm2', win: 11, tab: 1, tty: 'ttys004', title: 'acme-dashboard', cmd: 'claude', cwd: dirOf('acme-dashboard'), repo: dirOf('acme-dashboard'), busy: true,
          agent: agentState({ sid: 's1', state: 'permission', since: ago(95 * 1000), detail: { tool: 'Bash', summary: 'npm run db:migrate' }, model: 'claude-opus-4-8',
            title: 'Wire up the quarterly revenue chart endpoint', prompt: 'Wire up the quarterly revenue chart endpoint and run the migration', pid: 4501, tty: 'ttys004', cwd: dirOf('acme-dashboard'), repo: dirOf('acme-dashboard') }) }),
        terminalEntry({ app: 'Terminal', win: 21, tab: 2, tty: 'ttys005', title: 'payments-api', cmd: 'claude', cwd: dirOf('payments-api'), repo: dirOf('payments-api'), busy: true,
          agent: agentState({ sid: 's2', state: 'input', since: ago(3 * MIN), model: 'claude-sonnet-4-6',
            title: 'Add idempotency keys to the Stripe webhook handler', prompt: 'Add idempotency keys to the Stripe webhook handler', pid: 4502, tty: 'ttys005', cwd: dirOf('payments-api'), repo: dirOf('payments-api') }) }),
        terminalEntry({ app: 'Terminal', win: 21, tab: 3, tty: 'ttys006', title: 'design-system', cmd: 'claude', cwd: dirOf('design-system'), repo: dirOf('design-system'), busy: true,
          agent: agentState({ sid: 's3', state: 'working', since: ago(22 * 1000), detail: { tool: 'Edit' }, model: 'claude-opus-4-8', mode: 'plan',
            title: 'Refactor the color token scale for dark mode', prompt: 'Refactor the color token scale for dark mode', pid: 4503, tty: 'ttys006', cwd: dirOf('design-system'), repo: dirOf('design-system') }) }),
        terminalEntry({ app: 'iTerm2', win: 11, tab: 2, tty: 'ttys007', title: 'mobile-app', cmd: 'claude', cwd: dirOf('mobile-app'), repo: dirOf('mobile-app'), busy: true,
          agent: agentState({ sid: 's4', state: 'working', since: ago(2 * MIN), model: 'claude-sonnet-4-6',
            title: 'Implement haptic feedback for swipe-to-refresh', prompt: 'Implement haptic feedback for the swipe-to-refresh gesture', pid: 4504, tty: 'ttys007', cwd: dirOf('mobile-app'), repo: dirOf('mobile-app') }) }),
        terminalEntry({ app: 'Terminal', win: 21, tab: 4, tty: 'ttys008', title: 'ml-experiments', cmd: 'npm run train', cwd: dirOf('ml-experiments'), repo: dirOf('ml-experiments'), busy: true }),
        terminalEntry({ app: 'iTerm2', win: 11, tab: 3, tty: 'ttys009', title: 'zsh', cmd: 'zsh', cwd: null, repo: null, busy: false })
      ]
    },
    timeline: [
      tlEvent('prompt', 'u1', dirOf('data-pipeline'), 8 * 1000, { prompt: '/loop run the tests and fix any failures until they pass' }),
      tlEvent('stop', 's3', dirOf('design-system'), 12 * 1000),
      tlEvent('permission', 's1', dirOf('acme-dashboard'), 95 * 1000, { detail: { tool: 'Bash', summary: 'npm run db:migrate' } }),
      tlEvent('prompt', 's2', dirOf('payments-api'), 60 * 1000, { prompt: 'Add idempotency keys to the Stripe webhook handler' }),
      tlEvent('start', 's4', dirOf('mobile-app'), 2 * MIN),
      tlEvent('idle', 's2', dirOf('payments-api'), 4 * MIN),
      tlEvent('prompt', 's3', dirOf('design-system'), 6 * MIN, { prompt: 'Refactor the color token scale for dark mode' }),
      tlEvent('start', 's3', dirOf('design-system'), 8 * MIN),
      tlEvent('end', 'sx', dirOf('internal-tools'), 12 * MIN),
      tlEvent('stop', 's1', dirOf('acme-dashboard'), 15 * MIN),
      tlEvent('start', 's1', dirOf('acme-dashboard'), 20 * MIN)
    ],
    hooks: {
      installed: true, partial: false, detailed: true,
      scriptPath: '/Users/dev/Library/Application Support/agentic-command-center/agent-hook.sh',
      settingsPath: '/Users/dev/.claude/settings.json',
      preview: '{ "hooks": { "SessionStart": [ … ], "Stop": [ … ], "Notification": [ … ] } }',
      previewDetailed: '{ "hooks": { "SessionStart": [ … ], "PreToolUse": [ … ], "PostToolUse": [ … ] } }'
    },
    panelPrefs: { notifyPermission: true, notifyInput: false, notifyStale: true, showPlainTerminals: true }
  }
}
