export interface RepoStatus {
  path: string
  name: string
  branch: string | null
  ahead: number
  behind: number
  changedCount: number
  hasUpstream: boolean
  /** Relative paths of changed (staged + unstaged + untracked) files. */
  changedFiles: string[]
  /** Human "time ago" of the latest commit, or null when unknown. */
  lastCommitRelative: string | null
  /** Subject line of the latest commit, or null when unknown. */
  lastCommitMessage: string | null
  /** Web (https) URL of the `origin` remote, or null when not derivable. */
  remoteUrl: string | null
  error?: string
}

export interface CommitPushResult {
  success: boolean
  error?: string
}

export interface ContributionDay {
  date: string
  count: number
  /** 0 = none, 1–4 = GitHub's quartile color levels */
  level: number
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
}

export interface ContributionData {
  total: number
  weeks: ContributionDay[][]
  error?: string
}

export interface UsageWindow {
  /** 0–100, rounded. */
  utilization: number
  /** ISO timestamp the window resets at, or null when unknown. */
  resetsAt: string | null
}

export interface ClaudeUsage {
  /** five_hour — current 5-hour session window. */
  session: UsageWindow
  /** seven_day — weekly window, all models. */
  weekly: UsageWindow
  /** seven_day_opus — weekly Opus window; null when the account has no separate Opus cap. */
  weeklyOpus: UsageWindow | null
  /** 'stale' when the token expired, otherwise a redacted error message. */
  error?: string
}

/** Latest CI / GitHub Actions conclusion for a repo's recent runs. */
export type CiState = 'pass' | 'fail' | 'pending' | 'none'

/** GitHub-derived, slower-moving per-repo intelligence (needs `gh` + a github remote). */
export interface RepoInsights {
  path: string
  ci: CiState
  /** Count of open pull requests. */
  openPRs: number
  /** Open PRs that request the signed-in user's review. */
  reviewRequests: number
  /** Open issues assigned to the signed-in user. */
  assignedIssues: number
  /** False when `gh` is missing or the repo has no github remote. */
  available: boolean
  error?: string
}

export type ClaudeModelClass = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

/** Per-project Claude Code activity, derived from local transcript files. */
export interface ClaudeProjectActivity {
  /** Imported repo path this activity maps to. */
  path: string
  costToday: number
  costWeek: number
  costTotal: number
  /** Total tokens (all kinds) spent today. */
  tokensToday: number
  /** Number of session transcripts for this project. */
  sessions: number
  /** ISO timestamp of the most recent activity, or null. */
  lastActivity: string | null
  /** True when a transcript was touched within the last few minutes. */
  active: boolean
  /** All-time cost split by model class. */
  models: Record<ClaudeModelClass, number>
}

export interface ClaudeActivity {
  projects: ClaudeProjectActivity[]
  costToday: number
  costWeek: number
  costTotal: number
  /** Recent plan-file titles from ~/.claude/plans. */
  plans: string[]
  /** False when ~/.claude/projects can't be read. */
  available: boolean
  error?: string
}

/** A listening localhost server mapped to an imported repo. */
export interface DevServer {
  port: number
  pid: number
  command: string
  cwd: string
  /** Imported repo this server's working directory belongs to. */
  repoPath: string
}

/** npm scripts declared in a repo's package.json. */
export interface RepoScripts {
  path: string
  scripts: string[]
}

export type ViewMode = 'compact' | 'dashboard'

/** A GitHub notification (mention, review request, CI failure, assignment, …). */
export interface GithubNotification {
  id: string
  repo: string
  title: string
  /** PullRequest, Issue, CheckSuite, Release, … */
  type: string
  /** review_requested, mention, assign, ci_activity, … */
  reason: string
  unread: boolean
  updatedAt: string
  /** Browsable URL, or null when one can't be derived. */
  url: string | null
}

export type CheckState = 'pass' | 'fail' | 'pending' | 'none'

/** One of the signed-in user's open pull requests, across all repos. */
export interface MyPr {
  repo: string
  number: number
  title: string
  url: string
  draft: boolean
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' when none. */
  reviewDecision: string
  checks: CheckState
  updatedAt: string
}

export interface Inbox {
  notifications: GithubNotification[]
  prs: MyPr[]
  available: boolean
  error?: string
}

/** Per-repo user metadata (favorite / group), keyed by repo path in the store. */
export interface RepoMeta {
  favorite?: boolean
  group?: string
}

/** A commit in the standup digest. */
export interface StandupCommit {
  hash: string
  message: string
  relative: string
}

export interface StandupRepo {
  path: string
  name: string
  commits: StandupCommit[]
}

export interface Standup {
  /** ISO start of the window. */
  since: string
  repos: StandupRepo[]
  totalCommits: number
  /** Estimated Claude cost over the same window (best-effort). */
  claudeCost: number
}

export interface SystemStats {
  /** 0–100 system CPU load (1-min loadavg ÷ cores). */
  cpu: number
  memUsed: number
  memTotal: number
  /** 0–100 used memory. */
  memPercent: number
}

/** A calendar event for today (best-effort, via macOS Calendar). */
export interface CalendarEvent {
  title: string
  start: string
  allDay: boolean
}

export interface CalendarData {
  events: CalendarEvent[]
  available: boolean
  error?: string
}

/** A single commit entry in the live activity feed. */
export interface CommitFeedEntry {
  repoPath: string
  repoName: string
  hash: string
  /** Original commit subject line. */
  message: string
  /** On-device AI summary (or the raw message while none is available). */
  summary: string
  author: string
  /** ISO 8601 timestamp. */
  date: string
  /** Human "time ago" label. */
  relative: string
  /** Browsable web URL of the origin remote, or null. */
  remoteUrl: string | null
}

export interface CommitFeed {
  entries: CommitFeedEntry[]
  /** True when on-device summarization (Apple Intelligence) is ready. */
  aiAvailable: boolean
  /** Display name of the summarization backend, or null when unavailable. */
  aiModel: string | null
  /** When unavailable: short human-readable reason / how to enable. */
  aiHint?: string
}

/** Lifecycle state of a Claude Code session, as shown in the terminals panel. */
export type AgentState = 'working' | 'permission' | 'input' | 'ended' | 'unknown'

/** A live Claude Code session, bound to a terminal when its tty is known. */
export interface AgentSessionState {
  /** Transcript/session UUID the state was derived from, or null. */
  sessionId: string | null
  state: AgentState
  /** 'event' = hook-fed (exact); 'heuristic' = inferred from transcripts. */
  confidence: 'event' | 'heuristic'
  /** ISO timestamp the current state began (best-effort), or null. */
  since: string | null
  /** What the session is waiting on, when known: the pending tool, and a
   *  short redacted summary of what it wants to do (hook-fed states only). */
  detail?: { tool?: string; summary?: string }
  /** Model id seen most recently in the transcript. */
  model?: string
  /** Claude Code permission mode (default / acceptEdits / plan / …). */
  permissionMode?: string
  /** Claude Code's own title for the session, when it saved one. */
  title?: string
  /** First line of the last submitted prompt. */
  lastPrompt?: string
  pid: number
  /** Normalized tty name (e.g. "ttys004"), or null when none. */
  tty: string | null
  cwd: string | null
  /** Imported repo the session's cwd belongs to, or null. */
  repoPath: string | null
}

/** One enumerable terminal surface (a Terminal.app tab / an iTerm2 session). */
export interface TerminalEntry {
  app: 'Terminal' | 'iTerm2'
  /** AppleScript window id — stable per window. */
  windowId: number
  /** 1-based tab position at enumeration time. */
  tabIndex: number
  /** Normalized tty (e.g. "ttys004"), or null when the tab exposes none. */
  tty: string | null
  /** Tab/session title, possibly empty. */
  title: string
  /** Humanized foreground command (e.g. "zsh", "npm run dev"), or null. */
  command: string | null
  cwd: string | null
  /** Imported repo the tab's cwd belongs to, or null. */
  repoPath: string | null
  /** True while the tab runs a foreground process. */
  busy: boolean
  /** Claude session bound to this tty, when one exists. */
  agent: AgentSessionState | null
}

/** Per-app AppleScript (Automation) consent state. */
export type AutomationState = 'ok' | 'denied' | 'not-running'

/** A Claude session running somewhere we can't enumerate (tmux, IDE pane, …). */
export type UnboundSession = AgentSessionState & {
  /** Hosting app guessed from the process tree, when derivable. */
  host?: string
}

export interface TerminalsSnapshot {
  entries: TerminalEntry[]
  unbound: UnboundSession[]
  automation: { terminal: AutomationState; iterm: AutomationState }
  error?: string
}

/** Click-to-focus target; the tty is the stable cross-app join key. */
export interface FocusTarget {
  app: 'Terminal' | 'iTerm2'
  /** Normalized tty name, e.g. "ttys004". */
  tty: string
}

/** State of the opt-in Claude Code hook integration for exact session states. */
export interface HooksStatus {
  /** True when every event hook points at this app's recorder script. */
  installed: boolean
  /** True when only some hooks are present (e.g. a partial manual edit). */
  partial: boolean
  /** True when the per-tool-call hooks (PreToolUse/PostToolUse) are also on. */
  detailed: boolean
  scriptPath: string
  settingsPath: string
  /** Pretty-printed JSON of exactly what install merges into settings.json. */
  preview: string
  /** Same, for the detailed (per-tool telemetry) variant. */
  previewDetailed: string
  error?: string
}

/** One recent Claude Code lifecycle event (hook-fed sessions only). */
export interface AgentTimelineEvent {
  /** ISO timestamp. */
  ts: string
  sessionId: string
  kind: 'start' | 'prompt' | 'permission' | 'idle' | 'stop' | 'end'
  cwd: string | null
  /** Imported repo the event's cwd belongs to, or null. */
  repoPath: string | null
  /** The pending tool + redacted summary (kind 'permission'). */
  detail?: { tool?: string; summary?: string }
  /** First line of the submitted prompt (kind 'prompt'). */
  prompt?: string
}

/** Terminals-panel preferences: notification routing + visibility. */
export interface PanelPrefs {
  /** Notify when a session starts waiting for permission. */
  notifyPermission: boolean
  /** Notify when a turn finishes (your-turn transitions). */
  notifyInput: boolean
  /** One nudge when a session has been waiting more than five minutes. */
  notifyStale: boolean
  /** Show terminals that aren't running Claude. */
  showPlainTerminals: boolean
}
