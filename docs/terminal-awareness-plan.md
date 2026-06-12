# Terminal & Agent Session Awareness — Architecture

> **Status: implemented.** This document began as the design plan for the feature set and is now
> its as-built record. Every feature below shipped on the `multi-terminal` branch; the
> [delivery record](#9-delivery-record) maps each phase to its commits, and
> [§8](#8-decisions-resolved) records how the original open questions were settled. Where the
> implementation improved on the plan (live findings changed a few mechanisms for the better),
> the text describes what was actually built and notes the delta.

The feature: a live view of every terminal open on the machine, which ones are running Claude
Code, and — most importantly — which ones are **blocked waiting on the user** (a permission
prompt, or an idle "your turn" state). Blocked terminals flash in a docked panel; clicking one
jumps straight to that exact window/tab (and, for tmux, the exact pane) so the prompt can be
answered.

The idea was adapted from [c11](https://github.com/Stage-11-Agentics/c11), a Swift/AppKit
terminal multiplexer built for coordinating parallel coding agents. We adapted the *ideas* — the
attention model and the signal sources — not the implementation. c11 is AGPL-3.0 (tmux lineage);
this repo is MIT, so no code was taken, only a clean-room design fitted to our architecture and
ethos.

---

## 1. What c11 does, and why our version is different

c11 is a **terminal host**: a native macOS multiplexer (Ghostty renderer) where workspaces
contain split panes of terminals, browsers, and markdown. Because it *owns* the terminals, it has
three privileged signal sources:

| c11 mechanism | How it works |
|---|---|
| **Foreground-process detection** | For every pane's registered TTY, a single periodic `ps -t <ttys>` sweep picks the foreground process per TTY and matches the binary against a table ("this pane is running claude / codex / a plain shell"). |
| **Claude Code lifecycle via hooks** | A PATH-scoped `claude` wrapper (active only inside c11 terminals) injects `--session-id` and `--settings` flags so Claude Code's own **hooks** report lifecycle events back to the app over a socket. Their rule: never write to `~/.claude/settings.json` — per-invocation injection only, possible *because* they control the PATH of every shell they host. |
| **Self-reported "surface manifests"** | Agents announce role/status/progress to the sidebar via a CLI; the sidebar shows per-pane status chips and attention states. |

The Command Center is the opposite category of app: an **outside-in observer**. It doesn't host
terminals, doesn't control PATH, and can't read pane contents. The adaptation as shipped:

- c11's *foreground-process-per-TTY* idea → ours, via `ps` + AppleScript enumeration of
  Terminal.app and iTerm2 (`procs.ts`, `terminals.ts`).
- c11's *Claude-hooks-for-lifecycle* idea → ours, via Claude Code's documented hook system
  writing per-session event files we watch (`agentevents.ts`, `hooks-setup.ts`). Opt-in global
  install for everything; c11-style per-invocation `--settings` injection for sessions the app
  launches itself (`launchAgent`).
- c11's *attention chips + jump-to-pane* → ours, as a docked panel with flashing entries,
  health-bar chip, dock badge + bounce, native notifications, and tty-matched click-to-focus
  (pane-aware for tmux).

**Non-goals, upheld:** hosting or embedding terminals, split/workspace layout management,
embedded browsers, agents reshaping our UI, reading terminal screen contents, and PATH
shims/wrappers around the user's `claude` binary.

---

## 2. Feature list — all shipped

### Core

1. **Terminals panel** — a pull-out, docked window (the activity feed's frameless child-window
   mechanism, generalized) listing every Terminal.app tab and iTerm2 session: app, title, working
   directory, mapped repo, and the foreground command.
2. **Live Claude session states** — per-session badges: `working` (with the running tool in
   detailed mode), `needs permission` (with the asking tool and a redacted summary of what it
   wants), `your turn`, each with a waiting-duration label. Inferred states render dashed;
   hook-fed states solid.
3. **Needs-you flash + click-to-jump** — `permission` entries flash red, `input` amber; waiting
   over five minutes escalates the flash. Clicking selects that exact window/tab/session by tty
   (for tmux: reveals the pane first) and activates the app. Focus is the *only* action.
4. **Attention routing** — a red `N waiting on you` chip leads the health bar, the toolbar toggle
   pulses while the panel is closed, the dock icon carries a badge (and bounces once when the
   count rises), and native notifications fire on permission transitions — all gated by
   user preferences.
5. **Waiting-reason detail** — "Bash — `npm test`" from the `PermissionRequest` payload,
   credential-scrubbed before display.

### Extended

6. **Session telemetry** — session title (Claude Code's own `ai-title`), the last submitted
   prompt, model chip, and non-default permission-mode chip on every entry.
7. **Agent events timeline** — the panel's second tab: a newest-first stream of lifecycle
   moments (session started, prompt submitted, asked to use a tool, turn finished, session
   ended), repo-tagged with relative times.
8. **Launch agent here** — a spark button on every repo card and a `⌘K → Start Claude session
   in <repo>` palette entry open a new Terminal window at the repo running `claude`; when the
   global hooks aren't installed, the launch carries a per-invocation `--settings` file wiring
   the same recorder (full tracking, zero global config changes).
9. **Stale-waiting escalation** — one nudge notification after five minutes of waiting (bounded
   at an hour so sessions deliberately left idle don't nag), plus the faster flash.
10. **tmux awareness** — sessions on tmux server ptys bind to the tab hosting an attached
    client (`tmux · session:window` entries); focusing routes `switch-client` →
    `select-window` → `select-pane` before surfacing the tab. Detached sessions list under
    "Elsewhere".

### Beyond the plan (added during implementation)

- **Per-tab title-glyph correction** — Claude Code prefixes each tab's title with a Braille
  spinner frame while working and `✳` when idle. The title is per-tab where transcript inference
  is per-project, so the glyph disambiguates two sessions sharing one project dir.
- **Transcript metadata records** — `ai-title`, `permission-mode`, and `last-prompt` records at
  transcript tails supply session titles, modes, and current tasks *without* hooks; the
  `system/turn_duration` record is an explicit, timestamped end-of-turn marker.
- **Per-tool detailed telemetry** — an opt-in hook variant adds `PreToolUse`/`PostToolUse` so
  entries read "working · Bash" while a tool runs (one recorder spawn around every tool call;
  off by default).
- **Panel preferences** — persisted toggles for permission/turn/stale alerts and plain-shell-tab
  visibility.
- **Unbound activation** — sessions in hosts without per-tab scripting (Cursor, VS Code,
  Ghostty) are clickable: app-level activation via `open -a`.

---

## 3. Signal inventory — three independent layers

House rule (same as every other panel): each layer is optional and degrades alone. No Automation
permission → no terminal binding, but session states still surface as unbound entries. No
hooks → heuristic states. Nothing breaks anything else, and none of it touches the network.

### L1 — Terminal topology (zero setup; AppleScript) — `terminals.ts`

One `osascript` per *running* terminal app per tick (a `ps`-based running check guarantees the
enumeration never launches an app), with the `execFile` + timeout + `redactError` pattern from
`calendar.ts`:

- **Terminal.app**: windows → tabs, exposing `tty`, `custom title`, `busy`. Tabs don't expose an
  index, so a loop counter records position.
- **iTerm2**: windows → tabs → sessions, exposing `id`, `name`, `tty`, `is processing`.

Fields are joined with a `|||` separator; ttys are normalized to ps's notation (`ttys004`) and
serve as the join key everywhere. Automation consent is reported per app
(`ok | denied | not-running`); denial renders a how-to-grant notice rather than an empty pane.
`NSAppleEventsUsageDescription` ships via electron-builder `extendInfo` so the consent prompt
explains itself.

### L2 — Process truth (zero setup) — `procs.ts`

- One cached `ps -axo pid,ppid,tty,stat,pcpu,etime,args` pass serves all consumers (3s cache +
  in-flight dedupe).
- **Foreground per tty**: the `+` stat flag; among the foreground group, prefer a Claude CLI,
  else the newest pid (the actual command rather than login/shell wrappers).
- **Claude CLI detection**: executable basename `claude` (also behind a `node`/`bun` launcher),
  case-sensitive — the Claude *desktop app* binary is `Claude` and must not match.
- **Active-descendant probe**: distinguishes an executing tool from an idle permission prompt;
  long-idle children (MCP servers) don't count — only runnable / CPU-consuming / recently
  started descendants.
- **tty-host derivation**: walking the tty session-leader's parents labels the hosting app for
  terminals we can't enumerate (iTermServer, Terminal.app, Cursor/VS Code pty-hosts, tmux,
  Ghostty).
- `lsof -a -p <pid> -d cwd -Fn` resolves working directories (30s cache), reusing the
  dev-servers pattern; cwd → repo is the same prefix match as `listDevServers`.

### L3 — Claude session state

Two sources, merged in `agentsessions.ts`: hook-fed sessions (confidence `event`) take precedence
per tty; heuristics (confidence `heuristic`) fill everything they don't cover, with session-id
dedupe for hook sessions whose tty binding failed.

#### L3a — Hook events (opt-in; exact; push-driven) — `agentevents.ts` + `hooks-setup.ts`

Hook set (none on the per-tool hot path by default):

| Hook event | Meaning | Payload used |
|---|---|---|
| `SessionStart` | session began/resumed → working | `model`, `cwd`, `transcript_path` |
| `UserPromptSubmit` | user pressed enter → working | `prompt` (first line) |
| `PermissionRequest` | dialog visible → permission | `tool_name`, `tool_input` |
| `Notification` (`permission_prompt\|idle_prompt`) | permission / idle → permission / input | `notification_type`, `message` |
| `Stop` | turn finished → input | — |
| `SessionEnd` | session over → ended | — |
| `PreToolUse` / `PostToolUse` *(detailed variant only)* | per-tool progress → working · tool | `tool_name`, `tool_input` |

**Recorder**: dependency-free `/bin/sh` under the app's data folder. It wraps each stdin payload
with the claude process's pid and controlling tty (walked up from `$PPID`, with a found-flag so
an unmatched walk records pid 0) and appends one JSON line to
`<userData>/agent-events/<session_id>.jsonl`. It never writes to stdout, so it cannot influence
a permission decision.

**Transport**: per-session append-only files + `fs.watch` on the directory. Events buffered
while the app is closed replay on launch; ancient orphans are pruned; ended sessions' files are
deleted after a grace period; a pid-liveness sweep (every 30s) catches crashes that never fired
`SessionEnd`. State changes push `sessions:update` to every window after invalidating the
snapshot cache, so the panel flashes the instant a dialog appears.

**Install paths** (all shipped):
1. **Opt-in global install** — the consent card shows the exact JSON before merging into
   `~/.claude/settings.json`: parse-first (unparsable content aborts — never clobber), symlinks
   followed, atomic tmp+rename, timestamped backup beside the file. Our entries are identified
   by the recorder living under the app's userData dir, so uninstall removes exactly ours and
   leaves foreign hooks untouched. Re-install switches variants cleanly (ours are stripped
   before re-adding).
2. **Per-launch injection** — sessions started via "launch agent here" run
   `claude --settings <generated.json>` when global hooks are absent.
3. **Manual** — the consent box's JSON is the copyable snippet.

**The clearing rule** (the hybrid that makes the state machine sound): nothing fires when the
user *answers* a permission prompt, but the transcript gains the `tool_result` the instant the
approved tool runs — so each waiting session's transcript is `fs.watch`ed and a write newer than
the waiting event flips it straight back to `working` (GC sweep as backup).

**Timeline**: a capped in-memory ring of lifecycle events feeds the Events tab. Files re-fold
from scratch for state, so each session keeps a high-water mark of emitted lines to keep the
timeline duplicate-free; the `PermissionRequest` + `Notification` pair that fires for a single
dialog is collapsed. The timeline outlives session cleanup (recent history) and resets with the
app.

#### L3b — Transcript heuristics (zero setup; fallback + clearing signal) — `agentsessions.ts`

For each live claude process: cwd → `~/.claude/projects/<encoded-cwd>` → newest transcript →
read only the tail (last 32KB) and classify:

| Observation | Inferred state |
|---|---|
| file written < ~8s ago | **working** |
| last record `system/turn_duration` or assistant `end_turn` | **input** (your turn) |
| assistant `tool_use` pending > ~12s, process + descendants idle | **permission** (likely) |
| assistant/user mid-exchange records | **working** |

The tail also yields `ai-title`, `permission-mode`, `last-prompt`, and the model — so heuristic
entries still show titles, modes, and tasks. The per-tab title glyph (spinner/`✳`) then corrects
the per-project inference per tab. Known limit, by design: two sessions in one project share the
newest transcript until hooks disambiguate by session id; the UI marks all heuristic states
dashed with a "possibly waiting" tooltip.

### L4 (addendum) — tmux topology — `tmux.ts`

A session inside tmux runs on a pty owned by the tmux *server*; no tab carries its tty. The
chain back to something focusable: pane tty → pane (`list-panes -a`) → tmux session → attached
client (`list-clients`) → client tty → the enumerated tab. Bound sessions get a synthesized
entry (`tmux · session:window`) on the hosting tab; focus runs `switch-client` →
`select-window` → `select-pane`, then the normal tab focus. Fields are joined with the ASCII
unit separator (session names can contain anything printable); no server short-circuits to null
on one fast failing call, cached.

### State machine (as built)

States: `working` · `permission` · `input` · `ended` · `unknown`.

| Trigger | → State |
|---|---|
| `SessionStart`, `UserPromptSubmit`, `PostToolUse` | `working` |
| `PreToolUse` *(detailed)* | `working` + tool detail |
| `PermissionRequest`, `Notification: permission_prompt` | `permission` (tool + redacted summary) |
| `Notification: idle_prompt`, `Stop` | `input` (UI escalates after 5 min) |
| transcript write newer than the waiting event | `working` |
| `SessionEnd`, or pid gone (30s sweep) | `ended` → entry clears, file deleted after grace |
| hooks absent | heuristic classification (table above) |

---

## 4. Architecture (as built)

```
src/main/procs.ts           ps table: foreground-per-tty, claude detection, descendants, lsof cwd
src/main/terminals.ts       AppleScript enumeration, joins, glyph correction, focus engine, host activation
src/main/agentsessions.ts   heuristic transcript classifier + event/heuristic merge
src/main/agentevents.ts     hook-event watcher: state machine, clearing rule, timeline, GC, push
src/main/hooks-setup.ts     consent-gated installer / uninstaller / variant switch + recorder script
src/main/tmux.ts            pane↔client mapping + pane reveal
src/renderer/src/components/TerminalsWindow.tsx   docked panel: Terminals|Events tabs, prefs, hooks card
```

Everything privileged lives in the main process behind typed IPC; the renderer stays sandboxed.
The detection modules are deliberately electron-free, so they can be bundled with esbuild and
smoke-tested under plain node (`hooks-setup` needs an `--alias:electron=<stub>`).

### Data flow

```
 osascript (Terminal, iTerm2)   ps -axo / lsof -d cwd    tmux list-panes/-clients   agent-events/*.jsonl   ~/.claude/projects/**.jsonl
        │ windows/tabs/tty            │ fg proc, pid,           │ pane↔client               │ hook events           │ tail classify,
        │ titles, busy                │ cwd, pcpu, etime        │ chains                    │ (fs.watch, push)      │ clearing writes
        └──────────────┬──────────────┴──────────┬──────────────┴──────────┬────────────────┴──────────┬───────────┘
                       ▼                         ▼                         ▼                           ▼
                 terminals.ts ◄── tty join ── procs.ts            agentevents.ts ──────── agentsessions.ts (merge)
                       │                                                 │ timeline                    │
                       └───────────── TerminalsSnapshot ─────────────────┴── ipcMain.handle / webContents.send
                                                  │
        TerminalsWindow (tabs, flash, prefs) · HealthBar chip · dock badge+bounce · notifications · RepoCard spark
```

### IPC surface (complete)

| `window.api` method | Channel | Action |
|---|---|---|
| `getTerminals(paths)` | `terminals:list` | merged `TerminalsSnapshot` (4s cache + in-flight dedupe) |
| `focusTerminal(target)` | `terminals:focus` | tmux pane reveal (when set) + AppleScript select/activate |
| `activateHostApp(host)` | `terminals:activateApp` | `open -a` for allowlisted hosts |
| `toggleTerminals()` | `terminals:toggle` | show/hide the docked panel |
| `getAgentTimeline(paths)` | `sessions:timeline` | recent lifecycle events, repo-resolved at the boundary |
| `onSessionsUpdate(cb)` | `sessions:update` *(push)* | fired by the watcher after cache invalidation |
| `getHooksStatus()` / `installHooks(detailed?)` / `uninstallHooks()` | `hooks:*` | consent-gated settings management |
| `getPanelPrefs()` / `setPanelPrefs(patch)` | `prefs:*` | persisted panel preferences |
| `setBadge(n)` | `badge:set` | dock badge; a rising count bounces once |
| `launchAgent(path)` | `actions:launchAgent` | new Terminal at the repo running claude (tracked) |

### Docked windows

The feed's docking was generalized into a dock table: the feed prefers the right edge, the
terminals panel the left; panels chain outward per side and fall back to the other side when the
display runs out of room, so two open panels never overlap. Each is a frameless child window
loading the same renderer bundle with a `#feed` / `#terminals` hash; ⌘W teardown notifies the
main window per panel; pin state stays synchronized.

### Refresh cadence

| Source | Interval |
|---|---|
| Terminal topology + joins | 5s while the panel is open; 15s background pass for the chip/badge |
| Hook events | instant (`fs.watch` → `sessions:update` push) |
| Waiting-state clears | instant (transcript `fs.watch`) with the GC sweep as backup |
| Session GC (dead pids, ended files) | 30s |
| Caches | snapshot 4s · ps 3s · lsof cwd 30s · tmux 4s |

### Attention routing

Entry flash (red/amber keyframes, faster when stale) → attention-first sort → health-bar chip
(`N waiting on you`: permission always counts; finished turns only while < 30 min old) → toolbar
pulse while closed → dock badge + one informational bounce on a rising count → native
notifications (permission transitions; optional turn alerts; one stale nudge per waiting spell,
bounded 5–60 min) — every notification class gated by the persisted preferences.

---

## 5. Security & privacy (as shipped)

- **Read-only stance.** Enumeration is passive; focus changes window/pane selection and nothing
  else; the panel never types, answers, or writes into a terminal.
- **The one write surface** is the opt-in hook install: exact-JSON consent, parse-first with
  abort on unparsable content, symlink-following atomic writes, timestamped backups, surgical
  uninstall preserving foreign hooks. The recorder never writes to stdout, so it cannot
  influence a Claude Code permission decision.
- **Event files are transcript-class data**: `0700` under userData, deleted shortly after
  session end, never exported with settings, never networked; only short, `redactSecrets`-
  scrubbed summaries of tool inputs reach the UI (verified: an embedded `ghp_…` token rendered
  as `***`).
- **Injection guards**: ttys must match `/^ttys\d{1,5}$/` before entering AppleScript; tmux pane
  ids must match `/^%\d+$/`; everything else reaches subprocesses as `execFile` args (no shell);
  host activation is allowlisted.
- **Permissions inventory**: Automation consent per terminal app (once each, like Calendar);
  no Accessibility, no Screen Recording, no Input Monitoring. Ad-hoc-signed builds may re-prompt
  Automation after updates (TCC identity) — documented in Troubleshooting.
- **Undocumented-internals discipline**: hook payloads and transcript layouts parse tolerantly;
  unknown shapes degrade to `unknown` state and heuristics; the panel never hard-fails.

---

## 6. Failure modes & degradations (as shipped)

| Situation | Behavior |
|---|---|
| Automation denied for an app | That app's tabs hidden; sessions still listed (unbound); a grant-access notice with the System Settings path |
| Hooks not installed | Heuristic badges, dashed, "possibly waiting" tooltip; consent card offers the upgrade |
| Claude inside tmux, client attached | Bound to the client's tab; click reveals the pane |
| Claude inside tmux, detached | "Elsewhere", host `tmux`, not clickable |
| Claude inside Cursor / VS Code / Ghostty | "Elsewhere" with the host label; click activates the app |
| Session over ssh / in a container | cwd unmappable → listed without a repo chip |
| Claude killed hard (no `SessionEnd`) | pid sweep marks it ended within ~30s |
| App closed while events accrue | Files buffer; replayed on launch; states reconciled against live pids before first paint |
| Two sessions in one project, no hooks | Project-level inference shared; per-tab title glyphs correct working/idle; hooks fully separate them |
| Hook schema / transcript drift | Tolerant parsing → `unknown` + heuristics |

---

## 7. Verification record

- **Live topology**: 8 surfaces across Terminal.app + iTerm2 enumerated; all 7 concurrent claude
  sessions classified correctly (the one working session `working`, idle ones `input`); titles
  lifted from `ai-title`; focus path exercised (including the gone-tab branch) and the hostile
  tty guard rejecting injection.
- **Recorder**: ran live under a real session — valid wrapped JSON line, pid/tty walk verified.
- **Watcher**: full lifecycle in a standalone harness — working → permission (tool + redacted
  summary) → transcript-write clear → input → ended, with push callbacks; timeline order,
  duplicate-freedom across re-folds, and the dialog-pair collapse asserted.
- **Installer**: merge idempotency, foreign-hook and unknown-key preservation, surgical
  uninstall, partial detection, variant switching — all asserted against fixtures.
- **App**: boot-tested clean after each phase; tsc + electron-vite build green at every commit.
- **tmux**: the no-server path verified live (snapshot unchanged on a tmux-less machine); the
  pane/client mapping follows the proven tty-join pattern but awaits a hands-on check against a
  live server.

---

## 8. Decisions, resolved

| Open question (original plan) | Resolution |
|---|---|
| Dock side / stacking | Feed right, terminals left, chaining outward with side fallback — no overlap case remains |
| Show non-repo terminals? | Shown by default; a persisted "shell tabs" toggle hides them (visibility only — counts and alerts see everything) |
| Notification defaults | Permission on, turn off, stale nudge on — all three persisted toggles in the panel footer |
| One window or two | Two windows; the Events surface became a second *tab* of the terminals panel rather than a feed tab |
| `PostToolUse` detailed telemetry | Shipped as the opt-in "per-tool detail" variant (PreToolUse + PostToolUse) with its own consent preview |

---

## 9. Delivery record

| Phase | Commits |
|---|---|
| Plan | `89a3acd` design document |
| 1 — zero-setup panel | `64250ca` detection layers (procs / agentsessions / terminals + dock table) · `9585c0b` docked panel UI, flash, chip, toolbar pulse |
| 2 — exact states | `ea5793a` event watcher + consent installer · `853356b` push updates, notifications, dock badge, hooks card · `919182c` README |
| 3 — extended | `d411669` palette launch + telemetry chips · `ec9a6d9` timeline backend, detailed variant, host activation, prefs, bounce · `4857718` Events tab, prefs toggles, unbound activation, stale escalation · `32f558e` repo-card launch button · `30c06ba` README · `efe8756` tmux mapping |

Remaining nice-to-haves (not features): a README screenshot of the panel, and a hands-on tmux
verification when a live server is available.
