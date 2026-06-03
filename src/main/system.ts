import { cpus, loadavg, totalmem, freemem } from 'os'
import type { SystemStats } from '../shared/types'

/** Coarse system load + memory snapshot (no external deps). */
export function getSystemStats(): SystemStats {
  const cores = cpus().length || 1
  // 1-minute load average normalized to core count, clamped to 0–100%.
  const cpu = Math.min(100, Math.round((loadavg()[0] / cores) * 100))
  const memTotal = totalmem()
  const memUsed = memTotal - freemem()
  const memPercent = Math.round((memUsed / memTotal) * 100)
  return { cpu, memUsed, memTotal, memPercent }
}
