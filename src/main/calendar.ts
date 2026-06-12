import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CalendarData, CalendarEvent } from '../shared/types'
import { redactError } from './redact'

const execFileAsync = promisify(execFile)

// Reading Calendar.app over AppleScript can be slow and may prompt for
// Automation permission, so cache aggressively and bail out fast.
const CACHE_MS = 300_000
let cache: { at: number; value: CalendarData } | null = null
let inflight: Promise<CalendarData> | null = null

// Emit one line per event today: "title|||ISO-start|||allDayFlag".
const SCRIPT = `set output to ""
set today to current date
set startOfDay to today - (time of today)
set endOfDay to startOfDay + (1 * days)
tell application "Calendar"
  repeat with cal in calendars
    repeat with ev in (every event of cal whose start date ≥ startOfDay and start date < endOfDay)
      set sd to start date of ev
      set output to output & (summary of ev) & "|||" & (sd as «class isot» as string) & "|||" & (allday event of ev) & linefeed
    end repeat
  end repeat
end tell
return output`

async function compute(): Promise<CalendarData> {
  // Test/demo harness: a demo profile must never read the user's real
  // calendar (event titles are personal data).
  if (process.env.ACC_DEMO) return { events: [], available: false }
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', SCRIPT], {
      timeout: 8000,
      maxBuffer: 1024 * 1024
    })
    const events: CalendarEvent[] = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, start, allDay] = line.split('|||')
        return { title: title || '(untitled)', start: start ?? '', allDay: /true/i.test(allDay ?? '') }
      })
      .sort((a, b) => a.start.localeCompare(b.start))
    return { events, available: true }
  } catch (err) {
    // No Calendar access / permission denied / timeout — degrade silently.
    return { events: [], available: false, error: redactError(err) }
  }
}

export async function getCalendar(): Promise<CalendarData> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.value
  if (inflight) return inflight
  inflight = compute()
    .then((value) => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
