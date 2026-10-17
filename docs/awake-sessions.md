# Awake sessions — design record

As-built notes for the keep-awake feature: a corner widget that holds the Mac awake (lid closed
included) for a fixed, user-chosen duration, then restores everything. Behaviour follows
[Insomnia](https://github.com/krishhgg/Insomnia) (a Swift menu-bar app) re-implemented inside the
Electron main process; the UI follows the command center's own glass/hairline/accent language.

**Using it:** the step-by-step walkthrough, settings table, and screenshots live in the README's
[Awake sessions](../README.md#awake-sessions-keep-the-mac-awake) section
(`screenshot-awake-start.png`, `screenshot-awake.png`, `screenshot-awake-settings.png`, all from the
synthetic dataset via `npm run screenshots awake`).

## 1. Feature list

| Area | Behaviour |
|---|---|
| Duration | Days / Hours / Minutes pills (ceilings 30 / 23 / 59, two digits, ↑/↓ nudge, Enter starts) + presets 30m · 1h · 2h · 4h · 8h · 12h · 1d · 3d. Min 1 min, max 30 days. Never a toggle. |
| Refresh | Opening the popover calls `refreshAwake()`, which re-checks access + battery and pushes, so a rule installed from Terminal shows immediately. |
| Running | Live clock, "until <time>", progress bar, add-time chips (+15m +30m +1h +2h, `+…` custom), status tags, hold-to-end (0.6 s ring; release / slide off cancels; holding Space or Enter on the focused control does the same, keyup / blur cancels). |
| Sleep hold | `sudo -n pmset -a disablesleep 1` when the sudoers rule exists (`mode: 'lid'`), always plus `powerSaveBlocker('prevent-app-suspension')`. Without the rule: assertion only (`mode: 'assertion'`, "Lid open only"). |
| Health bar | `Awake · <countdown>` chip while a session runs (accent = `lid`, amber = `assertion`); `Awake restore pending` when `restorePending`. |
| Clamshell | `readLid()` = `AppleClamshellState` + `hasExternalDisplay()` (Electron `screen.getAllDisplays()` has a `!internal` display; test hook `ACC_SIMULATE_DISPLAY=<file>` reads `external`/`internal`). A closed lid **with** an external display is `clamshell` (in use): lid actions are skipped and Low Power on lid close isn't wanted. The 2 s poll acts on transitions of *away* (= closed && !clamshell), so plugging/unplugging a display with the lid shut behaves like opening/closing it. On relaunch, a session that isn't away has its lid actions undone. |
| Lid close | Only in `lid` mode (or under `ACC_SIMULATE_LID`) — in assertion mode the Mac sleeps on close anyway. Sleep the display (`pmset displaysleepnow`, best effort), mute (osascript), Low Power Mode (`pmset -b lowpowermode 1`), SIGSTOP the freeze list. Lid open undoes all of it. |
| Agents | Opt-in `extendWhileAgentsWork`: at expiry, if the terminals snapshot shows any Claude session in `working`, extend 15 min (`autoExtendedBy`), capped at 12 h total; first extension notifies. Waiting states (`permission`, `input`) don't count. |
| Auto-start | Opt-in `autoStartWithAgents`: `autoStartTick()` every 60 s (armed in `initAwake`) — no session, clean runtime, ≥ 1 working agent, not suppressed → `startSession(30 min, auto = true)` + notification. `session.auto` sessions always take the agent-extension path in `expire()`. Ending any session with reason `user` sets `autoSuppressed` until a tick sees zero working agents. The renderer can't set `auto` (IPC passes only seconds). |
| App Nap | Opt-in `disableAppNapForAgents`: at start, for each installed agent app (`AGENT_APPS`, Insomnia's list; `bundlePath()` must resolve — never creates a domain), `defaults read <id> NSAppSleepDisabled` → journal `runtime.appNap[{bundleId, previous: true/false/null}]` → `defaults write … -bool YES`. Already-YES and unreadable apps skipped; ids limited to `[A-Za-z0-9._-]`, never `NSGlobalDomain`. `releaseAppNap()` (in `restore()`) writes back or `defaults delete`s, clearing each entry only after success. The backstop does the same with `plutil` + `defaults`. Toggling the rule mid-session takes effect at once: `updateAwakeConfig()` calls `holdAppNap()` / `releaseAppNap()` inside the chain (verified live: on → both stand-ins YES; off → back to NO and absent). |
| Outage nudge | Opt-in `tmuxNudge`: `net.isOnline()` polled every 5 s during a session (`offlineSince` → amber *Offline* tag). Back online after ≥ 90 s → `nudgeMarkedPanes()` (`src/main/tmux.ts`): `list-panes -a`, then per pane `show-options -qpv @insomnia-nudge` must be exactly `on`, `display-message` flags `dead/in_mode/input_off` must be `0 0 0`, the session must still be the same, then `send-keys -l continue` (+ `Enter` only with `tmuxNudgePressesEnter`). Notifies with the count. |
| Browsers | `src/main/browsers.ts`: `scanThrottledBrowsers()` (lsappinfo pid → `ps -ww -o args=`, both `UNTHROTTLE_FLAGS` must be present) for Chrome, Chromium, Arc, Comet — refreshed on popover open and every 60 s in a session. `relaunchUnthrottled()` after an inline confirm: read args twice (same `lstart`), AppleScript quit, wait ≤ 10 s (else launch nothing), `open -b <id> --args <flags> <profile args>`, wait ≤ 5 s. Card shows when `lidReady` (idle) or `mode === 'lid'` (running). |
| Start guard | `startSession()` reads battery (and simulated heat) first and refuses — with a warning — when on battery below `endFloor` or at critical heat with heat rules on, so a session never starts only to end at the next floor poll. The agent watcher hits the same guard (the warning is de-duplicated). |
| Floors | On battery: LPM below `lowPowerFloor` (40), end below `endFloor` (10, 0 = off). Heat rules: LPM at `serious`, end at `critical`. |
| Recovery | Journal before every change; reconcile at launch; launchd backstop for crashes; quit ends the session first. |
| Export / import | `exportSettings()` includes `awakeConfig`; `importSettings()` passes it through `sanitizeAwakeConfig()` (only known keys whose type matches the default; freeze-list ids must match `[A-Za-z0-9.-]+`) and then `setAwakeConfig()` (floor ordering), after which the IPC handler calls `updateAwakeConfig({})` to push. Sessions, the journal, and the sudoers rule are never exported. |
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

**Backstop**: `~/Library/LaunchAgents/com.jashan.agenticcommandcenter.awake-backstop.plist` (any
non-default profile, `ACC_USER_DATA`, appends `.<sha256(journal path)[:10]>` to the label and file
so copies of the app never collide)
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

### Releases

- **v1.5.0** (`20d57bf`, docs `f9718d1`) — awake sessions: timed sleep hold, lid-close actions,
  floors, journal + launchd backstop, agent auto-start / extension, tmux nudge, App Nap, browser
  unthrottling. First production run: a 5-hour lid-mode session in the installed app expired on
  schedule and restored sleep, Low Power Mode, and audio with a clean journal.
- **v1.5.1** — post-release fixes found in use:
  - **Clamshell:** a closed lid with an external display no longer counts as "away" — no muting,
    freezing, Low Power, or display sleep while you work on the big screen (`c2b36c6`).
  - **Start guard:** no session starts below the battery end limit or at critical heat; the
    popover explains why (`1608749`).
  - **Keyboard:** hold Space / Enter on the focused end control to end a session (`f89def1`).
  - **Settings export / import** carries the awake configuration, sanitised on import (`2d64c77`).
  - **Test hooks** for battery, heat and external display; every floor verified live (`247894b`).
  - **Settings apply mid-session:** toggling App Nap holds / restores it at once (`96663b9`); with
    the lid shut, toggling *Mute audio* mutes / unmutes and editing the freeze list freezes /
    resumes immediately (`updateAwakeConfig()`, `resumeFrozen(keep)`).
  - **Clickable notifications:** clicking an awake notification brings the main window forward with
    the popover open (`revealAwake()` → `awake:open` → `onAwakeOpen`).
  - **One owner per profile:** a second running copy of the app on the same profile (e.g. `npm run
    dev` beside the installed app) stays passive — it no longer takes over the live session on
    launch and then ends it on quit. `passiveOwner` keeps an empty in-memory journal; journal
    writes, the backstop, start/extend/retry, auto-start, and the quit-restore all stand down.
  - **Backstop isolation:** the launchd backstop label is per-profile for non-default profiles, so a
    dev build or test profile ending its session can't remove the installed app's crash protection.
  - Dev: `npm run fix:electron` re-signs the revoked dev Electron (`5987d3f`).

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
- **Keyboard hold + shared hold, live (2026-10-17):** Space / Enter held 900 ms ended a session,
  250 ms did not; mouse hold unchanged. These test sessions ran while the user's installed v1.5.0
  app held a real lid-mode session: each found `SleepDisabled 1` already set, took it as a shared
  hold without claiming it, and ending them left the user's sleep hold and Low Power Mode intact.
- **Clamshell, live (2026-10-17):** found because the user's own v1.5.0 session muted audio and
  turned on Low Power Mode while they worked on an external display with the lid shut. Fixed and
  verified: simulated lid closed + external → nothing frozen; display unplugged → sleeper frozen;
  plugged back in → resumed; and with no simulation at all, the user's real closed lid + external
  monitor read `clamshell=true` with nothing frozen.
- **Battery & heat floors, live (2026-10-17):** with `ACC_SIMULATE_BATTERY`, `ACC_SIMULATE_THERMAL`
  and `ACC_FLOOR_POLL_MS=2000`: 35% on battery kept running; 8% on battery ended (`battery`); 8% on
  AC kept running; serious heat kept running with a red *Hot* tag; critical heat ended
  (`thermal`); heat rules off + critical kept running. (Low Power claiming was already verified in
  the lid-mode run; here the user's own session held it, so the dev session correctly didn't.)
- **Backstop isolation + quit, live (2026-10-17):** with the user's installed app running a real
  24 h lid session, a dev session on a test profile armed its own `…awake-backstop.<hash>` job; the
  user's job was untouched (same run count, still pointing at their journal). `app.quit()` mid-
  session ended the dev session first — journal cleared, its backstop removed, its assertion
  released — and left the user's sleep hold in place.
- **Passive second copy, live (2026-10-17):** a dev build on the user's *real* profile, beside the
  installed app's live 24 h session: reported `managedElsewhere=2711`, refused start, ignored end,
  and quitting it left the user's journal owner, session id, `SleepDisabled 1`, and backstop all
  unchanged. (Before this fix it would have taken the session over on launch and ended it on quit.)
- **Testing hooks**: `ACC_SIMULATE_LID=<file>` — the lid reads closed while the file says `closed`;
  `ACC_SIMULATE_OFFLINE=<file>` — the network reads down while it says `offline`;
  `ACC_TMUX_BIN=<path>` — a stand-in tmux. `ACC_SIMULATE_BATTERY=<file>` — `<percent> battery|ac`;
  `ACC_SIMULATE_THERMAL=<file>` — `nominal|fair|serious|critical`; `ACC_FLOOR_POLL_MS` — faster
  battery/heat poll; `ACC_SIMULATE_DISPLAY=<file>` — `external|internal`. The nudge was verified against a logging fake tmux:
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
