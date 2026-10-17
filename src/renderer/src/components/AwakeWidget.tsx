import { useCallback, useEffect, useRef, useState } from 'react'
import type { AwakeConfig, AwakeState } from '../../../shared/types'
import { IconEye, IconGear } from './icons'
import { EXTENSIONS, PRESETS, clock, countdown, endLabel, shortDuration } from '../lib/awake'
import '../awake.css'

interface Props {
  state: AwakeState | null
  /** Ask the parent to open the popover (command palette shortcuts). */
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Field = 'days' | 'hours' | 'minutes'
const CEILING: Record<Field, number> = { days: 30, hours: 23, minutes: 59 }
const FIELD_LABEL: Record<Field, string> = { days: 'Days', hours: 'Hours', minutes: 'Minutes' }
const FIELDS: Field[] = ['days', 'hours', 'minutes']

type Duration = Record<Field, string>
const EMPTY: Duration = { days: '', hours: '', minutes: '' }

function seconds(d: Duration): number {
  return (Number(d.days) || 0) * 86400 + (Number(d.hours) || 0) * 3600 + (Number(d.minutes) || 0) * 60
}

function fromSeconds(s: number): Duration {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  // Fields that would be zero stay empty, so "2h" fills only Hours.
  return { days: d ? String(d) : '', hours: h ? String(h) : '', minutes: m ? String(m) : '' }
}

const END_REASON: Record<NonNullable<AwakeState['lastEnd']>['reason'], string> = {
  expired: 'timer ran out',
  user: 'ended early',
  battery: 'battery floor reached',
  thermal: 'critical heat',
  quit: 'app quit',
  recovered: 'recovered after restart'
}

/** Days / Hours / Minutes pills. Digits only, two wide, each capped at its
 *  ceiling, so what is on screen is always a usable value. Enter submits. */
function DurationFields({
  value,
  onChange,
  onSubmit,
  autoFocus
}: {
  value: Duration
  onChange: (d: Duration) => void
  onSubmit: () => void
  autoFocus?: boolean
}): JSX.Element {
  const refs = useRef<Record<Field, HTMLInputElement | null>>({ days: null, hours: null, minutes: null })

  useEffect(() => {
    if (autoFocus) refs.current.hours?.focus()
  }, [autoFocus])

  const set = (f: Field, raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(-2)
    if (digits && Number(digits) > CEILING[f]) return
    onChange({ ...value, [f]: digits })
    // Two digits typed: move along to the next pill.
    if (digits.length === 2) {
      const next = FIELDS[FIELDS.indexOf(f) + 1]
      if (next) refs.current[next]?.focus()
    }
  }

  const onKey = (f: Field, e: React.KeyboardEvent<HTMLInputElement>): void => {
    const i = FIELDS.indexOf(f)
    if (e.key === 'Enter') {
      e.preventDefault()
      onSubmit()
    } else if (e.key === 'Backspace' && !value[f] && i > 0) {
      refs.current[FIELDS[i - 1]]?.focus()
    } else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === value[f].length && i < 2) {
      refs.current[FIELDS[i + 1]]?.focus()
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && i > 0) {
      refs.current[FIELDS[i - 1]]?.focus()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const n = Math.min(CEILING[f], Math.max(0, (Number(value[f]) || 0) + (e.key === 'ArrowUp' ? 1 : -1)))
      onChange({ ...value, [f]: n ? String(n) : '' })
    }
  }

  return (
    <div className="awake-fields">
      {FIELDS.map((f) => (
        <label key={f} className={`awake-field ${value[f] ? 'filled' : ''}`}>
          <input
            ref={(el) => {
              refs.current[f] = el
            }}
            inputMode="numeric"
            value={value[f]}
            placeholder="0"
            onChange={(e) => set(f, e.target.value)}
            onKeyDown={(e) => onKey(f, e)}
            onFocus={(e) => e.currentTarget.select()}
            title={f === 'days' ? 'Up to 30 days' : `0–${CEILING[f]}`}
          />
          <span>{FIELD_LABEL[f]}</span>
        </label>
      ))}
    </div>
  )
}

/** Press and hold to end: a ring draws around the button over 0.6 s and only
 *  a completed ring ends the session. Releasing or sliding off springs it back,
 *  so a stray click can't kill a session. Holding Space or Enter does the same
 *  from the keyboard; letting go early, or moving focus away, cancels. */
function HoldToEnd({ onEnd }: { onEnd: () => void }): JSX.Element {
  const HOLD_MS = 600
  const [progress, setProgress] = useState(0)
  const raf = useRef<number | null>(null)
  const started = useRef(0)

  const cancel = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    setProgress(0)
  }, [])

  const begin = (): void => {
    if (raf.current !== null) return // already holding
    started.current = performance.now()
    const step = (t: number): void => {
      const p = Math.min(1, (t - started.current) / HOLD_MS)
      setProgress(p)
      if (p >= 1) {
        raf.current = null
        onEnd()
        window.setTimeout(() => setProgress(0), 250)
        return
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }

  useEffect(() => cancel, [cancel])

  const R = 15
  const C = 2 * Math.PI * R
  return (
    <button
      className={`awake-hold ${progress > 0 ? 'holding' : ''}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        begin()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        if (!e.repeat) begin()
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') cancel()
      }}
      onBlur={cancel}
      title="Press and hold to end the session (or hold Space / Enter)"
      aria-label="End the awake session — press and hold, or hold Space or Enter"
    >
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r={R} className="awake-hold-track" />
        <circle
          cx="18"
          cy="18"
          r={R}
          className="awake-hold-ring"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
        />
      </svg>
      <span className="awake-hold-glyph" />
    </button>
  )
}

function Toggle({
  on,
  label,
  hint,
  onChange
}: {
  on: boolean
  label: string
  hint?: string
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <button className="awake-toggle-row" onClick={() => onChange(!on)} title={hint}>
      <span className="awake-toggle-label">{label}</span>
      <span className={`awake-switch ${on ? 'on' : ''}`} />
    </button>
  )
}

/** Percentage field that commits on blur / Enter, so typing "45" isn't
 *  clamped at "4" on the way. */
function FloorInput({
  value,
  min,
  max,
  onCommit
}: {
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}): JSX.Element {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (): void => {
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) setText(String(value))
    else if (n !== value) onCommit(n)
  }
  return (
    <input
      className="awake-num"
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 2))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      title={`${min}–${max}`}
    />
  )
}

function SettingsView({
  state,
  onBack
}: {
  state: AwakeState
  onBack: () => void
}): JSX.Element {
  const c = state.config
  const [app, setApp] = useState('')
  const [appError, setAppError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<AwakeConfig>): void => void window.api.setAwakeConfig(patch)

  const addApp = async (): Promise<void> => {
    if (!app.trim()) return
    setBusy(true)
    setAppError(null)
    const r = await window.api.resolveAwakeApp(app)
    setBusy(false)
    if ('error' in r) {
      setAppError(r.error)
      return
    }
    if (!c.freezeList.includes(r.bundleId)) set({ freezeList: [...c.freezeList, r.bundleId] })
    setApp('')
  }

  return (
    <div className="awake-settings">
      <div className="awake-head">
        <button className="awake-back" onClick={onBack} title="Back">
          ‹ Back
        </button>
        <span className="awake-title">Awake settings</span>
      </div>

      <div className="awake-group-label">Agents</div>
      <Toggle
        on={c.extendWhileAgentsWork}
        label="Stay awake while agents work"
        hint="When the timer runs out but a Claude session is still mid-turn, keep going 15 minutes at a time (up to 12 hours extra)."
        onChange={(v) => set({ extendWhileAgentsWork: v })}
      />
      <Toggle
        on={c.autoStartWithAgents}
        label="Start automatically when agents work"
        hint="With no session running, a working Claude session starts one (30 min, extended while agents keep working, up to 12 hours). Ending it by hand waits for the agents to go idle before it can start again."
        onChange={(v) => set({ autoStartWithAgents: v })}
      />
      <Toggle
        on={c.disableAppNapForAgents}
        label="Keep agent apps out of App Nap"
        hint="Sets NSAppSleepDisabled for installed terminals, editors and agent apps during a session and puts each previous value back afterwards. Applies to apps launched while it's on."
        onChange={(v) => set({ disableAppNapForAgents: v })}
      />

      <div className="awake-group-label">After a network outage</div>
      <Toggle
        on={c.tmuxNudge}
        label="Type “continue” into marked tmux panes"
        hint="When the network returns after 90 s or more, so a stalled agent retries. Only panes you marked are touched."
        onChange={(v) => set({ tmuxNudge: v })}
      />
      {c.tmuxNudge && (
        <>
          <Toggle
            on={c.tmuxNudgePressesEnter}
            label="Press Enter after it"
            hint="Also submits anything already typed in that pane — mark a dedicated agent pane."
            onChange={(v) => set({ tmuxNudgePressesEnter: v })}
          />
          <p className="awake-note">
            Mark a pane once: <code>tmux set-option -p -t &lt;pane&gt; @insomnia-nudge on</code>
          </p>
        </>
      )}

      <div className="awake-group-label">When the lid closes</div>
      <Toggle
        on={c.darkenDisplayOnLidClose}
        label="Sleep the display"
        hint="With sleep held off, macOS no longer turns the panel off on close. Best effort: another app holding a display assertion can veto it."
        onChange={(v) => set({ darkenDisplayOnLidClose: v })}
      />
      <Toggle
        on={c.muteOnLidClose}
        label="Mute audio"
        hint="Mutes on close and unmutes on open — only if it was unmuted before."
        onChange={(v) => set({ muteOnLidClose: v })}
      />
      <Toggle
        on={c.lowPowerOnLidClose}
        label="Low Power Mode"
        hint="Turns on while the lid is closed; off again when it opens unless a battery or heat rule still needs it."
        onChange={(v) => set({ lowPowerOnLidClose: v })}
      />

      <div className="awake-group-label">Freeze while closed</div>
      <div className="awake-apps">
        {state.freezeApps.length === 0 && <span className="awake-faint">No apps — nothing is frozen.</span>}
        {state.freezeApps.map((a) => (
          <span key={a.bundleId} className="awake-app" title={a.bundleId}>
            {a.name}
            <button
              onClick={() => set({ freezeList: c.freezeList.filter((id) => id !== a.bundleId) })}
              title={`Stop freezing ${a.name}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="awake-add">
        <input
          className="awake-input"
          placeholder="App name or bundle id"
          value={app}
          onChange={(e) => setApp(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addApp()}
        />
        <button className="term-btn" disabled={busy || !app.trim()} onClick={() => void addApp()}>
          Add
        </button>
      </div>
      {appError && <div className="awake-error-line">{appError}</div>}

      <div className="awake-group-label">Battery &amp; heat</div>
      <div className="awake-floor">
        <span>Low Power Mode below</span>
        <FloorInput value={c.lowPowerFloor} min={5} max={95} onCommit={(n) => set({ lowPowerFloor: n })} />
        <span className="awake-faint">%</span>
      </div>
      <div className="awake-floor">
        <span>End session below</span>
        <FloorInput value={c.endFloor} min={0} max={90} onCommit={(n) => set({ endFloor: n })} />
        <span className="awake-faint">% {c.endFloor === 0 ? '(off)' : ''}</span>
      </div>
      <Toggle
        on={c.thermalRules}
        label="Heat rules"
        hint="Low Power Mode at serious heat; end the session at critical heat."
        onChange={(v) => set({ thermalRules: v })}
      />

      <div className="awake-group-label">Lid-close access</div>
      <p className="awake-note">
        {state.lidReady
          ? 'Passwordless pmset is set up — sessions keep the Mac awake with the lid closed.'
          : 'Not set up — sessions only hold while the lid is open.'}
      </p>
      {!state.lidReady ? (
        <button className="term-btn primary" onClick={() => void window.api.setupAwakeLid()}>
          Set up lid-close access…
        </button>
      ) : (
        state.ruleOwned && (
          <button
            className="term-btn"
            disabled={!!state.session}
            onClick={() => void window.api.removeAwakeLid()}
            title={state.session ? 'End the session first' : undefined}
          >
            Remove access
          </button>
        )
      )}
    </div>
  )
}

/** Chromium browsers throttle hidden windows — every window, once the lid is
 *  closed. Offer a relaunch with the flags that stop it, confirmed inline
 *  because it quits the browser. */
function BrowserThrottleCard({ browsers }: { browsers: AwakeState['throttledBrowsers'] }): JSX.Element {
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const relaunch = async (id: string): Promise<void> => {
    setBusy(id)
    setConfirm(null)
    await window.api.relaunchAwakeBrowser(id)
    setBusy(null)
  }
  return (
    <div className="awake-browsers">
      {browsers.map((b) =>
        confirm === b.bundleId ? (
          <div key={b.bundleId} className="awake-browser confirm">
            <p>
              Quit and relaunch {b.name}? Windows and tabs come back only if {b.name} reopens them on
              startup.
            </p>
            <div className="awake-warn-actions">
              <button className="term-btn primary" onClick={() => void relaunch(b.bundleId)}>
                Quit &amp; relaunch
              </button>
              <button className="term-btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div key={b.bundleId} className="awake-browser">
            <span>
              <strong>{b.name}</strong> throttles its windows once the lid closes.
            </span>
            <button
              className="term-btn"
              disabled={busy === b.bundleId}
              onClick={() => setConfirm(b.bundleId)}
            >
              {busy === b.bundleId ? 'Relaunching…' : 'Relaunch unthrottled'}
            </button>
          </div>
        )
      )}
    </div>
  )
}

export default function AwakeWidget({ state, open, onOpenChange }: Props): JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [draft, setDraft] = useState<Duration>(EMPTY)
  const [extendOpen, setExtendOpen] = useState(false)
  const [extra, setExtra] = useState<Duration>(EMPTY)
  const [showSetupInfo, setShowSetupInfo] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const session = state?.session ?? null
  const active = !!session

  useEffect(() => {
    if (!active && !open) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active, open])

  // Refresh access + battery whenever the popover opens; reset transient views.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    void window.api.refreshAwake()
    setView('main')
    setExtendOpen(false)
  }, [open])

  // Click outside or Escape closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  if (!state) return null

  const endsAt = session ? new Date(session.endsAt).getTime() : 0
  const startedAt = session ? new Date(session.startedAt).getTime() : 0
  const remaining = Math.max(0, endsAt - now)
  const fraction = session ? Math.min(1, remaining / Math.max(1, endsAt - startedAt)) : 0
  const attention = state.warnings.length > 0 || state.restorePending
  const draftSecs = seconds(draft)
  const extraSecs = seconds(extra)

  const start = (secs: number): void => {
    if (secs < 60) return
    void window.api.startAwake(secs)
    setDraft(EMPTY)
  }

  const extend = (secs: number): void => {
    if (secs <= 0) return
    void window.api.extendAwake(secs)
    setExtra(EMPTY)
    setExtendOpen(false)
  }

  const RING_R = 9
  const RING_C = 2 * Math.PI * RING_R

  return (
    <div className="awake" ref={rootRef}>
      {open && (
        <div className="awake-pop" role="dialog" aria-label="Keep awake">
          {view === 'settings' ? (
            <SettingsView state={state} onBack={() => setView('main')} />
          ) : (
            <>
              <div className="awake-head">
                <span className={`awake-mark ${active ? 'on' : ''}`}>
                  <IconEye open={active} size={14} />
                </span>
                <span className="awake-title">{active ? 'Awake' : 'Keep awake'}</span>
                <span
                  className={`awake-mode ${state.lidReady ? 'lid' : 'open'}`}
                  title={
                    state.lidReady
                      ? 'Sessions hold with the lid closed (pmset disablesleep).'
                      : 'Without lid-close access a session only holds while the lid is open.'
                  }
                >
                  {active
                    ? state.mode === 'lid'
                      ? 'Lid-close safe'
                      : 'Lid open only'
                    : state.lidReady
                      ? 'Lid-close ready'
                      : 'Lid open only'}
                </span>
                <button className="icon-btn awake-gear" onClick={() => setView('settings')} title="Settings">
                  <IconGear />
                </button>
              </div>

              {attention && (
                <div className="awake-warn">
                  {state.warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                  {state.restorePending && state.warnings.length === 0 && (
                    <div>An earlier session's changes have not all been undone yet.</div>
                  )}
                  <div className="awake-warn-actions">
                    {state.restorePending && (
                      <button className="term-btn primary" onClick={() => void window.api.retryAwakeRestore()}>
                        Retry restore
                      </button>
                    )}
                    {state.warnings.length > 0 && (
                      <button className="term-btn" onClick={() => void window.api.dismissAwake()}>
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              )}

              {active && session ? (
                <>
                  <div className="awake-clock">{clock(remaining)}</div>
                  <div className="awake-until">
                    until {endLabel(new Date(endsAt), new Date(now))}
                    {session.extendedBy.length > 0 &&
                      ` · +${shortDuration(session.extendedBy.reduce((a, b) => a + b, 0))} added`}
                    {session.auto && ' · started for agents'}
                    {(session.autoExtendedBy?.length ?? 0) > 0 &&
                      ` · +${shortDuration((session.autoExtendedBy ?? []).reduce((a, b) => a + b, 0))} for agents`}
                  </div>
                  <div className="awake-progress">
                    <span style={{ width: `${fraction * 100}%` }} />
                  </div>

                  <div className="awake-chips">
                    {EXTENSIONS.map((s) => (
                      <button key={s} className="awake-chip" onClick={() => extend(s)} title="Add time">
                        +{shortDuration(s)}
                      </button>
                    ))}
                    <button
                      className={`awake-chip ${extendOpen ? 'active' : ''}`}
                      onClick={() => setExtendOpen((o) => !o)}
                      title="Add a custom amount"
                    >
                      +…
                    </button>
                  </div>
                  {extendOpen && (
                    <div className="awake-extend">
                      <DurationFields value={extra} onChange={setExtra} onSubmit={() => extend(extraSecs)} autoFocus />
                      <button className="term-btn primary" disabled={extraSecs <= 0} onClick={() => extend(extraSecs)}>
                        Add
                      </button>
                    </div>
                  )}

                  <div className="awake-status">
                    {state.clamshell ? (
                      <span
                        className="awake-stat"
                        title="Lid closed with an external display — you're using the Mac, so lid-close actions are skipped"
                      >
                        Clamshell
                      </span>
                    ) : (
                      <span className={`awake-stat ${state.lidClosed ? 'on' : ''}`}>
                        Lid {state.lidClosed ? 'closed' : 'open'}
                      </span>
                    )}
                    {state.batteryPercent !== null && (
                      <span className={`awake-stat ${state.onBattery ? 'warm' : ''}`}>
                        {state.onBattery ? 'Battery' : 'Plugged in'} {state.batteryPercent}%
                      </span>
                    )}
                    {state.config.extendWhileAgentsWork && (
                      <span
                        className={`awake-stat ${state.agentsWorking > 0 ? 'on' : ''}`}
                        title="The session extends itself while Claude sessions are mid-turn"
                      >
                        {state.agentsWorking > 0
                          ? `${state.agentsWorking} agent${state.agentsWorking === 1 ? '' : 's'} working`
                          : 'Agent-aware'}
                      </span>
                    )}
                    {state.offlineSince && (
                      <span
                        className="awake-stat warm"
                        title={
                          state.config.tmuxNudge
                            ? 'Marked tmux panes get “continue” if this lasts 90 s or more'
                            : 'Network is down'
                        }
                      >
                        Offline {shortDuration(Math.max(60, (now - new Date(state.offlineSince).getTime()) / 1000))}
                      </span>
                    )}
                    {state.appNapApps.length > 0 && (
                      <span className="awake-stat on" title={state.appNapApps.join('\n')}>
                        App Nap off · {state.appNapApps.length}
                      </span>
                    )}
                    {state.lowPowerByUs && <span className="awake-stat on">Low Power</span>}
                    {state.mutedByUs && <span className="awake-stat on">Muted</span>}
                    {state.frozen.length > 0 && (
                      <span className="awake-stat on" title={state.frozen.map((f) => f.bundleId).join('\n')}>
                        {new Set(state.frozen.map((f) => f.bundleId)).size} app
                        {new Set(state.frozen.map((f) => f.bundleId)).size === 1 ? '' : 's'} frozen
                      </span>
                    )}
                    {(state.thermal === 'serious' || state.thermal === 'critical') && (
                      <span className="awake-stat hot">Hot</span>
                    )}
                    {state.foreignSleepHold && (
                      <span className="awake-stat" title="Sleep was already disabled by another app; it is left as found.">
                        Shared hold
                      </span>
                    )}
                  </div>

                  {state.mode === 'lid' && state.throttledBrowsers.length > 0 && (
                    <BrowserThrottleCard browsers={state.throttledBrowsers} />
                  )}

                  <div className="awake-end-row">
                    <span className="awake-faint">Hold to end early</span>
                    <HoldToEnd onEnd={() => void window.api.endAwake()} />
                  </div>
                </>
              ) : (
                <>
                  <DurationFields value={draft} onChange={setDraft} onSubmit={() => start(draftSecs)} autoFocus />
                  <div className="awake-chips">
                    {PRESETS.map((s) => (
                      <button
                        key={s}
                        className={`awake-chip ${draftSecs === s ? 'active' : ''}`}
                        onClick={() => setDraft(fromSeconds(s))}
                      >
                        {shortDuration(s)}
                      </button>
                    ))}
                  </div>
                  <button
                    className="awake-start"
                    disabled={draftSecs < 60 || state.managedElsewhere !== null}
                    onClick={() => start(draftSecs)}
                  >
                    {draftSecs >= 60
                      ? `Stay awake until ${endLabel(new Date(now + draftSecs * 1000), new Date(now))}`
                      : 'Choose how long to stay awake'}
                  </button>

                  {!state.lidReady && (
                    <div className="awake-setup">
                      <p>
                        Closing the lid will still sleep this Mac. Allow four <code>pmset</code> commands
                        without a password to keep it awake with the lid closed.{' '}
                        <button className="awake-link" onClick={() => setShowSetupInfo((s) => !s)}>
                          {showSetupInfo ? 'Hide details' : 'Details'}
                        </button>
                      </p>
                      {showSetupInfo && (
                        <pre className="term-hooks-preview">
                          {`/etc/sudoers.d/agentic-command-center\n\n/usr/bin/pmset -a disablesleep 1\n/usr/bin/pmset -a disablesleep 0\n/usr/bin/pmset -b lowpowermode 1\n/usr/bin/pmset -b lowpowermode 0`}
                        </pre>
                      )}
                      <button className="term-btn primary" onClick={() => void window.api.setupAwakeLid()}>
                        Set up…
                      </button>
                    </div>
                  )}

                  {state.lidReady && state.throttledBrowsers.length > 0 && (
                    <BrowserThrottleCard browsers={state.throttledBrowsers} />
                  )}

                  {state.lastEnd && (
                    <div className="awake-faint awake-last">
                      Last session ended {endLabel(new Date(state.lastEnd.at), new Date(now))} ·{' '}
                      {END_REASON[state.lastEnd.reason]}
                    </div>
                  )}
                </>
              )}

              <div className="awake-foot">Use a stable, ventilated surface — never a closed bag.</div>
            </>
          )}
        </div>
      )}

      <button
        className={`awake-pill ${active ? 'active' : ''} ${open ? 'open' : ''} ${attention ? 'attn' : ''}`}
        onClick={() => onOpenChange(!open)}
        title={
          active
            ? `Mac held awake until ${endLabel(new Date(endsAt), new Date(now))} — click to add time or end`
            : 'Keep this Mac awake for a set time'
        }
      >
        <span className="awake-pill-eye">
          {active && (
            <svg width="24" height="24" viewBox="0 0 24 24" className="awake-pill-ring">
              <circle cx="12" cy="12" r={RING_R} className="track" />
              <circle
                cx="12"
                cy="12"
                r={RING_R}
                className="fill"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - fraction)}
              />
            </svg>
          )}
          <IconEye open={active} size={13} />
        </span>
        {active && <span className="awake-pill-time">{countdown(remaining)}</span>}
      </button>
    </div>
  )
}
