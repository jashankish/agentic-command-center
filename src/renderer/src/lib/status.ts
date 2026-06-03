import type { RepoStatus } from '../../../shared/types'

export type StateColor = 'green' | 'amber' | 'red' | 'gray'

export interface DerivedState {
  color: StateColor
  badge: string
  detail: string
  /** Whether clicking the box should open the sync (commit + push) dialog. */
  canSync: boolean
  /** Whether the repo is in a state worth the user's attention (for the health bar). */
  needsAttention: boolean
}

export function deriveState(s: RepoStatus): DerivedState {
  if (s.error) {
    return {
      color: 'gray',
      badge: 'Missing Repo',
      detail: s.error,
      canSync: false,
      needsAttention: true
    }
  }
  if (s.changedCount > 0) {
    const parts = [`${s.changedCount} changed`]
    if (s.ahead > 0) parts.push(`${s.ahead} to push`)
    if (s.behind > 0) parts.push(`${s.behind} to pull`)
    return {
      color: 'red',
      badge: parts.join(' · '),
      detail: `${s.changedCount} uncommitted change(s) on ${s.branch ?? '?'}.`,
      canSync: true,
      needsAttention: true
    }
  }
  if (!s.hasUpstream) {
    return {
      color: 'gray',
      badge: 'No upstream',
      detail: `Branch "${s.branch ?? '?'}" has no upstream. Syncing pushes with -u origin.`,
      canSync: true,
      needsAttention: true
    }
  }
  if (s.ahead > 0) {
    const badge = s.behind > 0 ? `${s.ahead} to push · ${s.behind} to pull` : `${s.ahead} to push`
    return {
      color: 'amber',
      badge,
      detail: `${s.ahead} commit(s) on ${s.branch} not yet pushed.`,
      canSync: true,
      needsAttention: true
    }
  }
  if (s.behind > 0) {
    return {
      color: 'amber',
      badge: `${s.behind} to pull`,
      detail: `${s.behind} commit(s) on origin/${s.branch} not yet pulled. Fetch/pull to update.`,
      canSync: false,
      needsAttention: true
    }
  }
  return {
    color: 'green',
    badge: 'Up to date',
    detail: `Clean and pushed (${s.branch}).`,
    canSync: false,
    needsAttention: false
  }
}
