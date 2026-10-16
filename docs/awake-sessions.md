# Awake sessions — design record

As-built notes for the keep-awake feature: a corner widget that holds the Mac awake (lid closed
included) for a fixed, user-chosen duration, then restores everything. Behaviour follows
[Insomnia](https://github.com/krishhgg/Insomnia) (a Swift menu-bar app) re-implemented inside the
Electron main process; the UI follows the command center's own glass/hairline/accent language.

## 1. Feature list

| Area | Behaviour |
|---|---|
| Duration | Days / Hours / Minutes pills (ceilings 30 / 23 / 59, two digits, ↑/↓ nudge, Enter starts) + presets 30m · 1h · 2h · 4h · 8h · 12h · 1d · 3d. Min 1 min, max 30 days. Never a toggle. |
| Running | Live clock, "until <time>", progress bar, add-time chips (+15m +30m +1h +2h, `+…` custom), status tags, hold-to-end (0.6 s ring; release / slide off cancels). |
| Sleep hold | `sudo -n pmset -a disablesleep 1` when the sudoers rule exists (`mode: 'lid'`), always plus `powerSaveBlocker('prevent-app-suspension')`. Without the rule: assertion only (`mode: 'assertion'`, "Lid open only"). |
| Lid close | Sleep the display (`pmset displaysleepnow`, best effort), mute (osascript), Low Power Mode (`pmset -b lowpowermode 1`), SIGSTOP the freeze list. Lid open undoes all of it. |
| Agents | Opt-in `extendWhileAgentsWork`: at expiry, if the terminals snapshot shows any Claude session in `working`, extend 15 min (`autoExtendedBy`), capped at 12 h total; first extension notifies. Waiting states (`permission`, `input`) don't count. |
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

iPhone-hotspot failover, tmux "continue" nudge, Chrome/Arc occlusion-throttling relaunch, App Nap
overrides, private-framework brightness save/restore (display sleep is used instead), Docker idle
freeze rule.

## 8. Delivery record

- **Live-tested** in the real app (CDP-driven, throwaway profile, `ACC_SIMULATE_LID`): UI start,
  hold-to-end (200 ms ignored, 900 ms ends), lid close/open (mute + SIGSTOP, then restore),
  `kill -9` → backstop restore within 5 s of expiry, `kill -9` + relaunch → takeover, agent-aware
  extension. Lid mode (`pmset disablesleep`, LPM) awaits an approved admin prompt.
- **Testing hook**: `ACC_SIMULATE_LID=<file>` — the lid reads closed while the file says `closed`.

- Branch `worktree-feature-insomnia-awake`. Screenshots via the headless harness:
  `npm run screenshots awake` (`screenshot-awake.png`, `screenshot-awake-settings.png`); the mock
  `window.api` in `capture.mjs` carries every `awake` method and `mock-data.mjs` an active session.
