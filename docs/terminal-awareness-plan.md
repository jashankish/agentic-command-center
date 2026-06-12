# Terminal & Agent Session Awareness — Feature Plan

This document plans a new capability for the Agentic Command Center: a live view of every
terminal open on the machine, which ones are running Claude Code, and — most importantly —
which ones are **blocked waiting on the user** (a permission prompt, or an idle "your turn"
state). Blocked terminals flash in the panel; clicking one jumps straight to that exact
window/tab so the prompt can be answered.

The idea is adapted from [c11](https://github.com/Stage-11-Agentics/c11), a Swift/AppKit
terminal multiplexer built for coordinating parallel coding agents. We adapt the *ideas* —
the attention model and the signal sources — not the implementation. c11 is AGPL-3.0
(tmux lineage); this repo is MIT, so no code is taken, only a clean-room design that fits
our architecture and ethos.

---

## 1. What c11 does, and why our version must be different

c11 is a **terminal host**: a native macOS multiplexer (Ghostty renderer) where workspaces
contain split panes of terminals, browsers, and markdown. Because it *owns* the terminals,
it has three privileged signal sources:

| c11 mechanism | How it works |
|---|---|
| **Foreground-process detection** | For every pane's registered TTY, a single periodic `ps -t <ttys>` sweep picks the foreground process per TTY and matches the binary against a table ("this pane is running claude / codex / a plain shell"). Triggered on pane creation, shell-integration hooks, focus changes, and a 10 s safety sweep. |
| **Claude Code lifecycle via hooks** | A PATH-scoped `claude` wrapper (active only inside c11 terminals) injects `--session-id` and `--settings` flags so Claude Code's own **hooks** report lifecycle events back to the app over a socket. Their rule: never write to `~/.claude/settings.json` or any user config — per-invocation injection only, which is possible *because* they control the PATH of every shell they host. |
| **Self-reported "surface manifests"** | Agents announce role/status/progress to the sidebar via a CLI (`c11 set-status`); the sidebar shows per-pane status chips and attention states. |

The Command Center is the opposite category of app: an **outside-in observer**. We don't
host terminals, don't control PATH, and can't read pane contents. So the adaptation is:

- c11's *foreground-process-per-TTY* idea → ours, via `ps` + AppleScript enumeration of
  Terminal.app and iTerm2 (we already use `osascript` for Calendar and `lsof` for dev
  servers — same toolbox).
- c11's *Claude-hooks-for-lifecycle* idea → ours, via Claude Code's documented hook system
  writing small event files we watch. Opt-in for globally-started sessions; c11-style
  per-invocation injection for sessions we launch ourselves.
- c11's *attention chips + jump-to-pane* → ours, as a docked panel (same mechanism as the
  activity feed) with flashing entries, health-bar chip, dock badge, and click-to-focus
  via AppleScript.

**Explicit non-goals** (c11 features that don't transfer to a dashboard): hosting or
embedding terminals, split/workspace layout management, embedded browsers, agents
reshaping our UI, reading terminal screen contents, and PATH shims/wrappers around the
user's `claude` binary.

---

## 2. Feature list

### Core (the ask)

1. **Terminals panel** — a pull-out, docked window (exactly like the activity feed's
   frameless child window) listing every open terminal surface: each Terminal.app tab and
   iTerm2 session, with app, title, working directory, mapped repo (when it's an imported
   one), and what's running in the foreground.
2. **Live Claude session states** — terminals running Claude Code get a state badge:
   `working`, `needs permission`, `your turn` (turn finished / idle prompt), with a
   timestamp ("waiting 3m"). Terminals without Claude just show their foreground command
   (`zsh`, `vite`, `ssh`, …).
3. **Needs-you flash + click-to-jump** — entries in `needs permission` / `your turn`
   pulse (red/amber). Clicking an entry focuses that exact window/tab/session and brings
   the terminal app to the front.
4. **Attention routing** — the signal escapes the panel: a health-bar chip
   (`2 waiting on you`), a pulsing toolbar toggle while the panel is closed, a macOS dock
   badge count, and a native notification on the *transition* into a waiting state
   (reusing the transition-guard pattern in `lib/notify.ts`).
5. **Waiting-reason detail** — for permission prompts, show *what* is being asked:
   "wants to run `npm test`", "wants to edit `src/main/git.ts`" — so the user can decide
   whether to switch now.

### Extended (same machinery, c11-inspired)

6. **Session telemetry row** (c11's surface-manifest analog) — expanding an entry reveals:
   model, permission mode, the current task (first line of the last submitted prompt),
   how long the current turn has been running, and time since session start.
7. **Agent events timeline** (c11's notifications-store analog) — a reverse-chronological
   stream of lifecycle events across all sessions ("16:42 acc — asked to run `git push`",
   "16:40 blog — turn finished"). Natural home: a second tab in the feed window, or a
   section at the top of the terminals panel.
8. **Launch agent here** (c11's spawn analog) — a repo-card / palette action that opens a
   new terminal at the repo and runs `claude`. Sessions we launch can carry
   `--settings <file>` with our hook config injected per-invocation — full tracking with
   zero global config changes (c11's constraint, adopted where it applies to us).
9. **Stale-waiting escalation** — a session waiting longer than N minutes re-notifies once
   and pulses harder. This addresses the real failure mode: an agent finished or asked for
   permission half an hour ago and was forgotten.
10. **tmux awareness** *(stretch)* — sessions inside tmux have a tmux pty, not a terminal
    tab tty. Map pane ↔ client (`tmux list-panes -a`, `list-clients`), and focus becomes
    `tmux select-window`/`select-pane` + focusing the attached client's terminal.

---

## 3. Signal inventory — three independent layers

House rule (same as every other panel): each layer is optional and degrades alone. No
Automation permission → no terminal binding, but session states still work. No hooks →
heuristic states. Nothing breaks anything else, and none of it touches the network.

### L1 — Terminal topology (zero setup; AppleScript)

One `osascript` call per terminal app per tick, same `execFile` + timeout + `redactError`
pattern as `calendar.ts`:

- **Terminal.app**: windows → tabs, each exposing `tty`, `custom title`, `busy` (a
  process is running), `processes` (names), `selected`.
- **iTerm2**: windows → tabs → sessions, each exposing `id`, `name`, `tty`,
  `is processing` (recent output activity).

Enumeration sketch (Terminal.app; iTerm2 analogous, one level deeper):

```applescript
tell application "Terminal"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (id of w) & "|||" & (index of t) & "|||" & (tty of t) ¬
        & "|||" & (busy of t) & "|||" & (custom title of t) & linefeed
    end repeat
  end repeat
  return out
end tell
```

Notes:

- Sending AppleEvents to each app triggers a one-time **Automation** consent prompt per
  app (like Calendar today). Denied → the panel shows a "grant access to see Terminal
  windows" row and the rest of the feature still works. We should also add
  `NSAppleEventsUsageDescription` to the bundle via electron-builder `extendInfo` so the
  prompt always carries an explanation.
- Skip the enumeration entirely for apps that aren't running (`pgrep -x` guard or
  `application "X" is running` in the script) to avoid launching them.
- **Ghostty / VS Code / Cursor integrated terminals** have no usable scripting dictionary
  for per-tab enumeration or focus. Claude sessions inside them still appear via L2/L3,
  labeled with the owning app when derivable from the process tree, and clicking falls
  back to `open -a <app>` (app-level focus only).

### L2 — Process table (zero setup)

- One `ps` pass over the TTYs collected in L1 (plus a full `-axo` pass to catch Claude
  sessions in terminals we can't enumerate):
  `ps -axo pid,ppid,tty,stat,pcpu,command`. The foreground process of a TTY is the one
  whose `stat` carries `+` — c11's exact trick, reimplemented trivially.
- Claude detection: foreground command matching `(^|/)claude( |$)` (also matches the
  node/bun launcher forms by checking the full args string).
- Working directory per interesting pid via `lsof -a -p <pid> -d cwd -Fn` — the same
  helper pattern as `cwdOf()` in `devservers.ts`, cached per pid.
- cwd → repo mapping reuses the prefix match from `listDevServers`.
- `pcpu` is kept as a weak discriminator for the heuristic layer (a Claude process blocked
  on a permission prompt sits at ~0% CPU; a working one doesn't).

### L3 — Claude session state

Two sources that complement each other. Hooks give *precise, push-based* states; the
transcript files we already parse give a *zero-setup fallback* and the clearing signal.

#### L3a — Hook events (opt-in; precise; event-driven)

Claude Code's hook system covers exactly the states we need, and all of the events below
are **off the per-tool-call hot path**, so subscribing adds no latency to the agent loop:

| Hook event | Meaning for us | Payload fields we use |
|---|---|---|
| `SessionStart` | session began/resumed | `session_id`, `cwd`, `transcript_path`, `model`, `source` |
| `UserPromptSubmit` | user pressed enter → working | `prompt` (first line, for "current task") |
| `PermissionRequest` | permission dialog visible | `tool_name`, `tool_input` |
| `Notification` (matcher `permission_prompt\|idle_prompt`) | permission prompt / idle "your turn" | `notification_type`, `message` |
| `Stop` | turn finished → your turn | — |
| `SessionEnd` | session over | — |

Every payload also carries `session_id`, `cwd`, `transcript_path`, and `permission_mode`.

**Transport: append-only files + `fs.watch`.** The hook command is a tiny dependency-free
`/bin/sh` script (installed under our userData dir) that appends one JSON line per event to
`~/Library/Application Support/agentic-command-center/agent-events/<session_id>.jsonl`.
File-based transport means events still accumulate while the app is closed (we replay the
tails on launch to rebuild state), there are no ports or sockets, and per-session files
eliminate interleaved-write concerns and make cleanup trivial.

The script also solves the **binding problem** — which terminal is this session in? Hooks
run as children of the `claude` process, so walking up from `$PPID` finds Claude's pid and
controlling TTY. That TTY joins L1 (which tab), and `cwd` joins the repo list:

```sh
#!/bin/sh
# Append one Claude Code hook payload, tagged with the claude process pid + tty.
DIR="$HOME/Library/Application Support/agentic-command-center/agent-events"
mkdir -p "$DIR"
payload=$(cat)
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$sid" ] || exit 0
pid=$PPID; tty=""; i=0
while [ "$i" -lt 6 ] && [ "$pid" -gt 1 ]; do          # hook may run via an intermediate sh
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || break
  case "$cmd" in *claude*) tty=$(ps -o tty= -p "$pid"); break ;; esac
  pid=$(ps -o ppid= -p "$pid" | tr -d ' '); i=$((i+1))
done
printf '{"ts":"%s","pid":%s,"tty":"%s","event":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${pid:-0}" "$tty" "$payload" >> "$DIR/$sid.jsonl"
exit 0
```

(Sketch — the real script needs the usual quoting hardening; `session_id` is a UUID so the
`sed` extraction is safe in practice.)

**Three ways to get the hooks active**, surfaced in a small "session tracking" settings
card:

1. **Opt-in global install** — a consent dialog shows the *exact* JSON that will be merged
   into `~/.claude/settings.json` (hooks config pointing at our script), then performs an
   atomic read-merge-write (tmp file + rename, timestamped `.bak` first, abort on parse
   errors, never clobber unknown keys). Our entries are identifiable by the script path
   living under our userData dir, so **uninstall** is one click and removes exactly ours.
2. **Per-launch injection** — sessions started via "Launch agent here" run
   `claude --settings <generated-hooks.json>`: full tracking for those sessions with zero
   global config changes. (This is c11's wrapper constraint translated to the one place we
   *do* control the invocation.)
3. **Manual** — show the snippet for users who prefer to paste it into their own settings.

**Event hygiene:** the events dir is `0700`; payloads can contain prompt first-lines and
tool inputs, i.e. the same sensitivity class as the transcripts they mirror — so files are
size-capped, deleted shortly after `SessionEnd` (or when the pid is gone), excluded from
settings export, and run through `redact.ts` before any UI display.

#### L3b — Transcript heuristics (zero setup; fallback + clearing signal)

`claude.ts` already locates each repo's transcript folder and tracks recency. We extend it
to read only the **tail** of the newest `.jsonl` per project (last few KB) and classify:

| Observation | Inferred state | Confidence |
|---|---|---|
| last record is an assistant `tool_use`, file idle > ~10 s, Claude pid alive at ~0% CPU | likely **needs permission** | heuristic |
| last record ends a turn (assistant text, no pending tool), pid alive | **your turn** | heuristic |
| file written within the last few seconds | **working** | high |
| no live Claude pid maps to the project | session over | high |

Heuristic states render visually distinct (hollow badge, "possibly waiting") so precision
is never overstated, with a one-line nudge toward enabling hooks for exact states.

**The hybrid is what makes the state machine sound.** With our event subset, nothing fires
at the moment the user *answers* a permission prompt — the next hook might be minutes away.
But the transcript file gets the `tool_result` line the instant the approved tool runs. So:
**hooks raise waiting states; transcript writes clear them** (any write newer than the
event timestamp downgrades `needs permission`/`your turn` back to `working`). An `fs.watch`
on the session's transcript makes the clear near-instant, with the polling pass as backup.

### State machine

States: `working` · `permission` · `input` (your turn) · `ended` · `unknown`.

| Trigger | → State |
|---|---|
| `SessionStart`, `UserPromptSubmit` | `working` |
| `PermissionRequest`, `Notification: permission_prompt` | `permission` (capture tool + input) |
| `Notification: idle_prompt`, `Stop` | `input` (with `since` timestamp; UI escalates to "stale" after N min) |
| transcript write newer than the waiting event | `working` |
| `SessionEnd`, or pid no longer alive (GC sweep every ~30 s) | `ended` → entry clears, event file scheduled for deletion |
| hooks absent | heuristic classification (table above) |

---

## 4. Architecture

Everything privileged stays in the main process behind typed IPC; the renderer remains
sandboxed. New modules mirror the existing one-concern-per-file layout:

```
src/main/terminals.ts        L1+L2: AppleScript enumeration, ps/lsof join, focus engine
src/main/agentsessions.ts    L3: event-dir watcher, session registry, heuristics, state machine
src/main/hooks-setup.ts      install / uninstall / status of the hook config + script
src/renderer/src/components/TerminalsWindow.tsx    the docked panel (mirrors FeedWindow)
```

### Data flow

```
 osascript (Terminal.app, iTerm2)     ps -axo / lsof -d cwd        agent-events/*.jsonl   ~/.claude/projects/**.jsonl
        │  windows/tabs/tty                │ fg process, pid,             │ hook events           │ tail classify,
        │  titles, busy                    │ cwd, pcpu                    │ (fs.watch, push)       │ clearing writes
        └──────────────┬───────────────────┴───────────────┬──────────────┴───────────┬───────────┘
                       ▼                                   ▼                          ▼
                terminals.ts ◄──── tty join ────── agentsessions.ts ── session registry + states
                       │                                   │
                       └────────── merged TerminalEntry[] ─┴── ipcMain.handle / webContents.send
                                                           │
                       TerminalsWindow (docked, flashes) · HealthBar chip · dock badge · notifications
```

### Shared types (sketch)

```ts
export type AgentState = 'working' | 'permission' | 'input' | 'ended' | 'unknown'

export interface AgentSessionState {
  sessionId: string | null            // null = heuristic-only binding
  state: AgentState
  confidence: 'event' | 'heuristic'
  since: string                       // ISO — when this state began
  detail?: { tool?: string; summary?: string }   // truncated + redacted permission ask
  model?: string
  permissionMode?: string
  lastPrompt?: string                 // first line of last submitted prompt
}

export interface TerminalEntry {
  app: 'Terminal' | 'iTerm2' | 'other'
  /** Focus handles; tty doubles as the stable join key. */
  windowId: number | null
  tabIndex: number | null
  sessionId: string | null            // iTerm2 session id
  tty: string | null
  title: string
  command: string | null              // foreground command
  cwd: string | null
  repoPath: string | null
  busy: boolean
  agent: AgentSessionState | null
}

export interface TerminalsSnapshot {
  entries: TerminalEntry[]
  /** Sessions detected but not bindable to an enumerable terminal (tmux, ssh, IDE). */
  unbound: AgentSessionState[]
  automation: { terminal: boolean; iterm: boolean }   // consent state per app
  hooksInstalled: boolean
  available: boolean
  error?: string
}
```

### IPC additions

| `window.api` method | Channel | Main-process action |
|---|---|---|
| `getTerminals()` | `terminals:list` | merged `TerminalsSnapshot` |
| `focusTerminal(target)` | `terminals:focus` | AppleScript select + activate |
| `onSessionsUpdate(cb)` | `sessions:update` *(push)* | fired by the event watcher (precedent: `feed:closed`) |
| `toggleTerminalsPanel()` | `terminalsPanel:toggle` | show/hide the second docked window |
| `getHooksStatus()` / `installHooks()` / `uninstallHooks()` | `hooks:*` | consent-gated settings merge |
| `launchAgent(repoPath)` *(phase 3)* | `agents:launch` | new terminal at repo running claude |

### The docked window

The feed already proves the pattern: a frameless child `BrowserWindow` loading the same
bundle with a location hash, repositioned on the parent's `move`/`resize`
(`positionFeedWindow()` in `src/main/index.ts`, hash routing in `renderer/src/main.tsx`).
Plan: generalize that into a small docked-window helper parameterized by hash + side, then:

- feed keeps the right edge (falling back left as today);
- terminals panel takes the opposite side, or stacks below the feed when both are open
  (decide during implementation — the helper makes either trivial);
- new toolbar toggle next to the activity button, highlighted when open, **pulsing when
  any session needs attention while the panel is closed**.

### Attention UX

- Entry flash: CSS keyframes on `permission` (red) and `input` (amber) entries — the
  existing card pulse animation style extends naturally. Sort: attention first, then
  working, then plain terminals.
- Health bar: `N waiting on you` chip (red tone) ahead of the existing chips.
- Dock badge: `app.setBadgeCount(n)` with the waiting count; optional single
  `app.dock.bounce('informational')` on a new waiting transition.
- Notifications: extend `checkNotifications` with the same primed/transition guard —
  fire on entering `permission` (default on) and `input` (default off, configurable),
  plus the one-time stale escalation.
- Click → `focusTerminal`: AppleScript locates the surface **by tty equality** (stable
  across tab reordering), selects window → tab → session, then `activate`. Target fields
  are validated (`/^\/dev\/ttys\d+$/`) before being embedded in a script — same injection
  discipline as `runScript`'s script-name guard. Fallback when not bindable: `open -a`.

```applescript
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "/dev/ttys004" then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
```

### Refresh cadence (extends the README table)

| Source | Interval |
|---|---|
| Terminal topology + process join | every 5 s while the panel is open; one light pass every ~20 s while closed (keeps badge/chip honest) |
| Hook events | instant (`fs.watch` on the events dir → push to renderer) |
| Waiting-state clears | instant (`fs.watch` on the waiting session's transcript) with the polling pass as backup |
| Transcript heuristics | piggyback the existing Claude poll, tightened to ~15 s for projects with a live Claude pid |
| Session GC (dead pids, old event files) | every 30 s |

Cost per tick is two `osascript` invocations, one `ps`, and a handful of cached `lsof`
calls — comparable to what the dev-server scan already does every 15 s.

---

## 5. Security & privacy

- **Read-only stance preserved.** Enumeration is passive; "focus" changes window focus and
  nothing else; no repo, file, or network is touched. The single new write surface is the
  **opt-in** hook install into `~/.claude/settings.json`: explicit consent showing the
  exact diff, timestamped backup, atomic write, refuse-on-parse-error, surgical uninstall.
- **Event files are transcript-class data** (prompt lines, tool inputs): `0700` dir under
  userData, size-capped, deleted on session end, excluded from settings export/import,
  scrubbed via `redact.ts` before display.
- **AppleScript injection guard** on every interpolated value (tty regex; everything else
  goes through `JSON.stringify` like `runScript` does today).
- **Permissions inventory:** Automation consent per terminal app (one prompt each, like
  Calendar). No Accessibility, no Screen Recording, no Input Monitoring — we never read
  screen contents or synthesize input. Note: ad-hoc-signed builds can re-prompt Automation
  consent after an update (TCC identity); worth a Troubleshooting entry.
- **Undocumented-internals discipline** (same as the README's stance on transcripts): hook
  payloads are documented but evolving; parse tolerantly, treat unknown shapes as
  `unknown` state, degrade to heuristics, never break the panel.

---

## 6. Failure modes & degradations

| Situation | Behavior |
|---|---|
| Automation denied for an app | That app's tabs aren't listed; Claude sessions still shown from L2/L3 as unbound entries; panel offers a "grant access" row |
| Hooks not installed | Heuristic badges ("possibly waiting"), visually distinct; nudge to enable |
| Claude inside tmux | Session appears unbound until phase-3 tmux mapping; focus falls back to activating the terminal app |
| Claude inside VS Code / Cursor / Ghostty | Listed via process tree with owning app when derivable; click activates the app only |
| Session over ssh / in a container | cwd unmappable → grouped under "elsewhere", no repo chip |
| Claude killed hard (no `SessionEnd`) | pid GC sweep marks it `ended` within ~30 s |
| App closed while events accrue | Files buffer; on launch the tails are replayed to rebuild state |
| Hook schema / transcript layout changes | Tolerant parsing → `unknown` state + heuristics; panel never hard-fails |

---

## 7. Phasing

**Phase 1 — Terminals panel MVP (zero-setup).** `terminals.ts` (enumerate + join + focus),
heuristic states from the extended transcript layer, the docked `#terminals` window with
flashing entries, health-bar chip, toolbar toggle. Ships the core ask with no configuration
at all. (~600–700 LOC: new main module, window plumbing, panel component, types, IPC.)

**Phase 2 — Precision + routing.** `hooks-setup.ts` + `agentsessions.ts` event watcher;
exact permission/input states with waiting-reason detail; notifications, dock badge, stale
escalation; settings card with install/uninstall. (~500 LOC.)

**Phase 3 — Extras.** "Launch agent here" with per-launch hook injection; session telemetry
rows; agent events timeline tab; tmux mapping.

Each phase is independently shippable and useful; 1 + 2 deliver the requested experience.

---

## 8. Open decisions

- **Dock side / stacking** when both the feed and the terminals panel are open (opposite
  sides vs. stacked on one side).
- **Non-repo terminals** in the panel: show by default under an "Other terminals" group
  (recommended — "every terminal" is the point), with a toggle to hide.
- **Notification defaults**: `permission` on, `input` off, stale escalation at 5 min — all
  three configurable to avoid alert fatigue.
- **One window or two**: terminals panel as its own docked window vs. a tabbed surface
  shared with the activity feed. Two windows is simpler and matches the current pattern;
  revisit if the edges get crowded.
- Whether phase 2 should also subscribe `PostToolUse` behind a "detailed telemetry" toggle
  (gives "running `Bash`…" granularity at the cost of one ~10 ms hook spawn per tool call).
