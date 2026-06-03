import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ContributionData } from '../shared/types'
import { redactError } from './redact'
import { resolveGh, ghEnv } from './gh'

const execFileAsync = promisify(execFile)

const LEVEL: Record<string, number> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4
}

const QUERY =
  'query { viewer { contributionsCollection { contributionCalendar { ' +
  'totalContributions weeks { contributionDays { ' +
  'date contributionCount contributionLevel weekday } } } } } }'

export async function getContributions(): Promise<ContributionData> {
  try {
    const { stdout } = await execFileAsync(
      resolveGh(),
      ['api', 'graphql', '-f', `query=${QUERY}`],
      { env: ghEnv(), maxBuffer: 10 * 1024 * 1024 }
    )
    const cal = JSON.parse(stdout).data.viewer.contributionsCollection.contributionCalendar
    const weeks = cal.weeks.map((w: { contributionDays: Array<Record<string, unknown>> }) =>
      w.contributionDays.map((d) => ({
        date: d.date as string,
        count: d.contributionCount as number,
        level: LEVEL[d.contributionLevel as string] ?? 0,
        weekday: d.weekday as number
      }))
    )
    return { total: cal.totalContributions, weeks }
  } catch (err) {
    return { total: 0, weeks: [], error: redactError(err) }
  }
}
