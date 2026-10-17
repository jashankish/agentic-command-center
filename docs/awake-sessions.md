# Awake sessions — design record

As-built notes for the keep-awake feature: a corner widget that holds the Mac awake (lid closed
included) for a fixed, user-chosen duration, then restores everything. Behaviour follows
[Insomnia](https://github.com/krishhgg/Insomnia) (a Swift menu-bar app) re-implemented inside the
Electron main process; the UI follows the command center's own glass/hairline/accent language.

## 1. Feature list

| Area | Behaviour |
|---|---|
| Duration | Days / Hours / Minutes pills (ceilings 30 / 23 / 59, two digits, ↑/↓ nudge, Enter starts) + presets 30m · 1h · 2h · 4h · 8h · 12h · 1d · 3d. Min 1 min, max 30 days. Never a toggle. |
| Refresh | Opening the popover calls `refreshAwake()`, which re-checks access + battery and pushes, so a rule installed from Terminal shows immediately. |
| Running | Live clock, "until <time>", progress bar, add-time chips (+15m +30m +1h +2h, `+…` custom), status tags, hold-to-end (0.6 s ring; release / slide off cancels). |
| Sleep hold | `sudo -n pmset -a disablesleep 1` when the sudoers rule exists (`mode: 'lid'`), always plus `powerSaveBlocker('prevent-app-suspension')`. Without the rule: assertion only (`mode: 'assertion'`, "Lid open only"). |
| Health bar | `Awake · <countdown>` chip while a session runs (accent = `lid`, amber = `assertion`); `Awake restore pending` when `restorePending`. |
| Lid close | Only in `lid` mode (or under `ACC_SIMULATE_LID`) — in assertion mode the Mac sleeps on close anyway. Sleep the display (`pmset displaysleepnow`, best effort), mute (osascript), Low Power Mode (`pmset -b lowpowermode 1`), SIGSTOP the freeze list. Lid open undoes all of it. |
| Agents | Opt-in `extendWhileAgentsWork`: at expiry, if the terminals snapshot shows any Claude session in `working`, extend 15 min (`autoExtendedBy`), capped at 12 h total; first extension notifies. Waiting states (`permission`, `input`) don't count. |
| Auto-start | Opt-in `autoStartWithAgents`: `autoStartTick()` every 60 s (armed in `initAwake`) — no session, clean runtime, ≥ 1 working agent, not suppressed → `startSession(30 min, auto = true)` + notification. `session.auto` sessions always take the agent-extension path in `expire()`. Ending any session with reason `user` sets `autoSuppressed` until a tick sees zero working agents. The renderer can't set `auto` (IPC passes only seconds). |
| App Nap | Opt-in `disableAppNapForAgents`: at start, for each installed agent app (`AGENT_APPS`, Insomnia's list; `bundlePath()` must resolve — never creates a domain), `defaults read <id> NSAppSleepDisabled` → journal `runtime.appNap[{bundleId, previous: true/false/null}]` → `defaults write … -bool YES`. Already-YES and unreadable apps skipped; ids limited to `[A-Za-z0-9._-]`, never `NSGlobalDomain`. `releaseAppNap()` (in `restore()`) writes back or `defaults delete`s, clearing each entry only after success. The backstop does the same with `plutil` + `defaults`. |
| Outage nudge | Opt-in `tmuxNudge`: `net.isOnline()` polled every 5 s during a session (`offlineSince` → amber *Offline* tag). Back online after ≥ 90 s → `nudgeMarkedPanes()` (`src/main/tmux.ts`): `list-panes -a`, then per pane `show-options -qpv @insomnia-nudge` must be exactly `on`, `display-message` flags `dead/in_mode/input_off` must be `0 0 0`, the session must still be the same, then `send-keys -l continue` (+ `Enter` only with `tmuxNudgePressesEnter`). Notifies with the count. |
| Browsers | `src/main/browsers.ts`: `scanThrottledBrowsers()` (lsappinfo pid → `ps -ww -o args=`, both `UNTHROTTLE_FLAGS` must be present) for Chrome, Chromium, Arc, Comet — refreshed on popover open and every 60 s in a session. `relaunchUnthrottled()` after an inline confirm: read args twice (same `lstart`), AppleScript quit, wait ≤ 10 s (else launch nothing), `open -b <id> --args <flags> <profile args>`, wait ≤ 5 s. Card shows when `lidReady` (idle) or `mode === 'lid'` (running). |
| Floors | On battery: LPM below `lowPowerFloor` (40), end below `endFloor` (10, 0 = off). Heat rules: LPM at `serious`, end at `critical`. |
| Recovery | Journal before every change; reconcile at launch; launchd backstop for crashes; quit ends the session first. |
| Palette | "Keep Mac awake for 1h / 4h / 8h", "Keep awake 1 hour longer", "End awake session", "Awake session…". |

## 2. Signals

- **Lid**: `ioreg -r -k AppleClamshellState -d 1` → `"AppleClamshellState" = Yes`, polled every 2 s
  only while a session runs.
- **Battery**: `pmset -g batt` (`'Battery Power'`, `NN%`), polled every 60 s plus Electron
  `powerMonitor` `on-battery` / `on-ac`.
- **Heat**: `powerMonitor` `thermal-state-change` (macOS); the state is read from the event's
  details object (`{ state }`) since Electron 31 has no typed getter. `unknown` until the first event.
- **Sleep bit**: `pmset -g` → `SleepDisabled 1` (absent when 0). **LPM**: the `Battery Power:`
  block of `pmset -g custom`.
- **Access**: `sudo -n -l /usr/bin/pmset -a disablesleep 1` exits 0 when any sudoers rule allows it
  (ours or Insomnia's).

## 3. Ownership rules

Nothing is claimed that the app did not change:
- If `SleepDisabled` is already 1 at start → use it, `foreignSleepHold`, never undo it.
- LPM is claimed only when it read **off** before we switched it on; never when unreadable.
- Mute is claimed only when it read **unmuted**; unmute on open only if still muted.
- A process already in state `T` is skipped. Frozen entries carry `ps -o lstart=` (whitespace
  collapsed); SIGCONT only when the start time still matches, so a reused pid is never signalled.
- Freeze denylist: `com.apple.*`, this app, agent hosts, terminals, editors, Docker, Tailscale.

After `disablesleep 1` the bit is re-read 1.2 s later (macOS can revert it); if it didn't hold, the
session drops to assertion mode with a warning.

## 4. Journal & recovery

`<userData>/awake/journal.json` (0600, atomic tmp + rename):

```ts
{ version: 1, session: { id, startedAt, endsAt, extendedBy[] } | null, mode, endsAtEpoch,
  appPid, appStartedAt, runtime: { sleepDisabledByUs, lowPowerByUs, mutedByUs, frozen[] } }
```

- Each change: write intent → act → on failure write the flag back.
- `initAwake()` (app ready): session still in the future → take it over (rewrite `appPid`, rearm
  backstop, restart monitors, undo lid actions if the lid is now open). Expired session or dirty
  runtime → `endSession('recovered')`.
- `before-quit`: if a session/dirty runtime exists, prevent, end with `'quit'`, then quit.
- A restore that fails leaves its flag set, shows a warning and **Retry restore**
  (`restorePending`), and keeps the backstop armed.

**Backstop**: `~/Library/LaunchAgents/com.jashan.agenticcommandcenter.awake-backstop.plist`
runs `/bin/sh <userData>/awake/backstop.sh <journal> <label> <plist>` every 60 s (RunAtLoad). It
reads the journal with `plutil -extract … raw`, exits while `appPid` is alive with a matching start
time, leaves a valid (unexpired) session alone, otherwise undoes the flags (sudo -n pmset, osascript
unmute, verified `kill -CONT`), writes a cleared journal and boots itself out. Installed on start,
removed on a complete end.

## 5. Concurrency

All lifecycle work (start / extend / end / lid / floors / retry) runs through one promise chain
(`exclusive`). Code already inside the chain calls `endNow()` directly — calling the queued
`endSession()` from inside would deadlock. The end fires from an exact `setTimeout` (capped at
~24.8 days) backed by a 15 s deadline check, since timers drift across system sleep.

Expiry goes through `expire()` (also inside the chain): it re-checks the deadline, then either
auto-extends for working agents (`countWorkingAgents()` → `getTerminals(listRepos())`, entries +
unbound sessions) or calls `endNow('expired')`. The 60 s battery timer also refreshes
`agentsWorking` while the rule is on.

## 6. Components

| File | Role |
|---|---|
| `src/main/awake.ts` | Engine: pmset/sudo, lid actions, floors, journal, backstop, sudoers setup, state push (`awake:update`). |
| `src/main/store.ts` | `awakeConfig` defaults + `setAwakeConfig` floor normalisation (end floor stays below the LPM floor unless 0). |
| `src/main/ipc.ts`, `src/preload/index.ts` | `awake:*` channels → `window.api.*Awake*`. |
| `src/shared/types.ts` | `AwakeConfig`, `AwakeSession`, `AwakeState`, `FrozenProcess`, `AwakeMode`, `AwakeEndReason`. |
| `src/renderer/src/components/AwakeWidget.tsx` | Pill + popover (main / settings views), `DurationFields`, `HoldToEnd`, `FloorInput`. |
| `src/renderer/src/lib/awake.ts` | `useAwake()` hook, presets, duration/clock formatting. |
| `src/renderer/src/awake.css` | Widget styles; reserves a 40 px strip at the bottom of `.app`. |

**Setup**: `osascript … do shell script … with administrator privileges` writes a temp file,
`visudo -cf` validates it, `install -m 0440 -o root -g wheel` places it at
`/etc/sudoers.d/agentic-command-center`. The rule: `<user> ALL=(root) NOPASSWD:` the four pmset
commands. Removal is refused while a session or unfinished restore exists.

## 7. Not ported from Insomnia

iPhone-hotspot failover, private-framework brightness save/restore (display sleep is used instead),
Docker idle freeze rule.

## 8. Delivery record

- **Live-tested** in the real app (CDP-driven, throwaway profile, `ACC_SIMULATE_LID`): UI start,
  hold-to-end (200 ms ignored, 900 ms ends), lid close/open (mute + SIGSTOP, then restore),
  `kill -9` → backstop restore within 5 s of expiry, `kill -9` + relaunch → takeover, agent-aware
  extension.
- **Lid mode, live (2026-10-17):** the real **Set up…** admin prompt installed
  `/etc/sudoers.d/agentic-command-center` (root:wheel 0440; `sudo -l` lists exactly the four pmset
  commands). A session set `SleepDisabled 1` (re-read, journaled as ours); simulated lid close turned
  battery Low Power Mode on and muted, lid open undid both with sleep still held; hold-to-end put
  `SleepDisabled` back to 0. `kill -9` with the lid closed: the launchd backstop ran
  `sudo -n pmset -a disablesleep 0` and `-b lowpowermode 0`, unmuted, and retired itself 5 s after
  expiry.
- **Testing hooks**: `ACC_SIMULATE_LID=<file>` — the lid reads closed while the file says `closed`;
  `ACC_SIMULATE_OFFLINE=<file>` — the network reads down while it says `offline`;
  `ACC_TMUX_BIN=<path>` — a stand-in tmux. The nudge was verified against a logging fake tmux:
  marked idle pane nudged (no Enter), unmarked pane skipped before any state read, marked pane in
  copy mode refused, and a 20 s outage nudged nothing. `ACC_EXTRA_BROWSERS=<ids>` adds stand-in
  browsers: a Cocoa test app was relaunched with both flags and its `--profile-directory`; an app
  that ignores quit was left alone with nothing launched; a non-browser id was refused. Real Chrome
  was only scanned (correctly reported throttled), never relaunched. `ACC_APPNAP_APPS=<ids>`
  replaces the agent list: a domain preset to NO and one with no key both went to YES and back (NO,
  and deleted), an uninstalled id was never written, and after `kill -9` the backstop restored both
  within 3 s of expiry. Auto-start (live, this job's own Claude session as the working agent): a
  30-minute `auto` session started at the first watcher tick; after a hand-held end it stayed off
  through two further ticks with the agent still working.

- Branch `worktree-feature-insomnia-awake`. Screenshots via the headless harness:
  `npm run screenshots awake` (`screenshot-awake.png`, `screenshot-awake-settings.png`); the mock
  `window.api` in `capture.mjs` carries every `awake` method and `mock-data.mjs` an active session.
