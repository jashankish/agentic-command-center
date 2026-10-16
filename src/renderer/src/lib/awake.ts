import { useEffect, useState } from 'react'
import type { AwakeState } from '../../../shared/types'

/** Live awake-session state: fetched once, then pushed by the main process on
 *  every change (start, extend, lid, floors, end). */
export function useAwake(): AwakeState | null {
  const [state, setState] = useState<AwakeState | null>(null)
  useEffect(() => {
    window.api.getAwake().then(setState)
    return window.api.onAwakeUpdate(setState)
  }, [])
  return state
}

export const PRESETS: number[] = [
  30 * 60,
  3600,
  2 * 3600,
  4 * 3600,
  8 * 3600,
  12 * 3600,
  24 * 3600,
  3 * 24 * 3600
]

export const EXTENSIONS: number[] = [15 * 60, 30 * 60, 3600, 2 * 3600]

/** "30m", "2h", "1d", "1h30m" — chip labels. */
export function shortDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join('') || '0m'
}

/** Remaining time for the countdown: "2d 3h", "3h 59m", or "12:34" in the last hour. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Precise remaining time for the expanded view: "3:59:12", "1d 03:59:12". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(total / 86400)
  const hh = String(Math.floor((total % 86400) / 3600)).padStart(2, '0')
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return d > 0 ? `${d}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

/** "9:41 PM", or "Sat 9:41 PM" when the end is not today. */
export function endLabel(at: Date, now = new Date()): string {
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (at.toDateString() === now.toDateString()) return time
  const days = (at.getTime() - now.getTime()) / 86_400_000
  const day =
    days < 6
      ? at.toLocaleDateString([], { weekday: 'short' })
      : at.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${day} ${time}`
}
