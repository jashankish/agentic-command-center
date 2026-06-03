import { readdir, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'

const IGNORE = new Set(['node_modules', '.Trash', 'Library', '.git', 'dist', 'out', 'build'])

/**
 * Walk a root directory looking for git repositories (folders containing a
 * `.git` entry). Depth-limited and breadth-capped so a deep tree can't hang the
 * scan; a repo's own subdirectories are not descended into.
 */
export async function discoverRepos(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = []
  let visited = 0

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited > 4000) return
    visited += 1

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    if (entries.some((e) => e.name === '.git')) {
      found.push(dir)
      return // don't descend into a repo's working tree
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORE.has(e.name)) continue
      // Skip symlinked dirs to avoid cycles.
      try {
        const st = await stat(join(dir, e.name))
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      await walk(join(dir, e.name), depth + 1)
    }
  }

  await walk(root, 0)
  return found.sort()
}
