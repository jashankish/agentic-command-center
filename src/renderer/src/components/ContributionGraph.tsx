import { useEffect, useState } from 'react'
import type { ContributionData } from '../../../shared/types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Month index from a 'YYYY-MM-DD' string (no Date() — avoids timezone drift).
const monthOf = (date: string): number => parseInt(date.slice(5, 7), 10) - 1

/** Current streak: consecutive days with contributions ending today/yesterday. */
function currentStreak(weeks: ContributionData['weeks']): number {
  const days = weeks.flat().sort((a, b) => a.date.localeCompare(b.date))
  let streak = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) streak += 1
    else if (i === days.length - 1) continue // today may not have activity yet
    else break
  }
  return streak
}

export default function ContributionGraph(): JSX.Element {
  const [data, setData] = useState<ContributionData | null>(null)

  useEffect(() => {
    const load = (): void => {
      window.api.getContributions().then((next) => {
        // Keep the last good chart if a periodic refresh errors transiently;
        // only surface an error when we have nothing to show yet.
        setData((prev) => (next.error && prev && prev.weeks.length > 0 ? prev : next))
      })
    }
    load()

    // Keep the chart current without restarting the app. We check every minute
    // (cheap) but only re-fetch when the local calendar day rolls over — so the
    // newest day's column appears right after midnight — or every ~10 minutes
    // so any new contributions made today show up too.
    let lastDay = new Date().toDateString()
    let ticks = 0
    const id = setInterval(() => {
      const today = new Date().toDateString()
      const dayChanged = today !== lastDay
      lastDay = today
      ticks += 1
      if (dayChanged || ticks % 10 === 0) load()
    }, 60_000)

    return () => clearInterval(id)
  }, [])

  if (!data) {
    return (
      <section className="contrib">
        <div className="contrib-status">Loading contributions…</div>
      </section>
    )
  }

  if (data.error || data.weeks.length === 0) {
    return (
      <section className="contrib">
        <div className="contrib-status">
          Couldn’t load GitHub contributions. Make sure <code>gh</code> is signed in.
        </div>
      </section>
    )
  }

  // One month label per week column: shown only when the month changes.
  let prevMonth = -1
  const monthLabels = data.weeks.map((week) => {
    const m = monthOf(week[0].date)
    if (m !== prevMonth) {
      prevMonth = m
      return MONTHS[m]
    }
    return ''
  })

  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', '']

  const streak = currentStreak(data.weeks)

  return (
    <section className="contrib">
      <div className="contrib-title">
        {data.total} contributions in the last year
        {streak > 0 && <span className="contrib-streak">🔥 {streak}-day streak</span>}
      </div>
      <div className="contrib-card">
        <div className="contrib-scroll">
          <div className="contrib-chart">
            <div className="contrib-daylabels">
              {dayLabels.map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="contrib-cols">
              <div
                className="contrib-months"
                style={{ gridTemplateColumns: `repeat(${data.weeks.length}, var(--sq))` }}
              >
                {monthLabels.map((m, i) => (
                  <span key={i}>{m}</span>
                ))}
              </div>
              <div
                className="contrib-grid"
                style={{ gridTemplateColumns: `repeat(${data.weeks.length}, var(--sq))` }}
              >
                {data.weeks.map((week, wi) => {
                  const byDay: Array<(typeof week)[number] | null> = Array(7).fill(null)
                  week.forEach((d) => {
                    byDay[d.weekday] = d
                  })
                  return byDay.map((d, di) =>
                    d ? (
                      <span
                        key={`${wi}-${di}`}
                        className={`contrib-cell lvl-${d.level}`}
                        title={`${d.count} contribution${d.count === 1 ? '' : 's'} on ${d.date}`}
                      />
                    ) : (
                      <span key={`${wi}-${di}`} className="contrib-cell empty" />
                    )
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="contrib-foot">
          <span className="contrib-learn">Learn how we count contributions</span>
          <span className="contrib-legend">
            Less
            <span className="contrib-cell lvl-0" />
            <span className="contrib-cell lvl-1" />
            <span className="contrib-cell lvl-2" />
            <span className="contrib-cell lvl-3" />
            <span className="contrib-cell lvl-4" />
            More
          </span>
        </div>
      </div>
    </section>
  )
}
