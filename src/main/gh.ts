import { accessSync } from 'fs'

// GUI apps launched from Finder don't inherit the shell PATH, so locate the
// gh binary explicitly across the common install locations.
export function resolveGh(): string {
  const candidates = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
  for (const c of candidates) {
    try {
      accessSync(c)
      return c
    } catch {
      // keep looking
    }
  }
  return 'gh'
}

/** A PATH-augmented env so child `gh` invocations resolve their own deps too. */
export function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:${process.env.PATH ?? ''}`
  }
}
