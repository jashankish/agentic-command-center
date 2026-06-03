import {
  IconSearch,
  IconClipboard,
  IconLayout,
  IconRefresh,
  IconPlus,
  IconPin,
  IconStar,
  IconSync,
  IconDownload,
  IconEditor,
  IconTerminal,
  IconFolder,
  IconExternal,
  IconChevron,
  IconPlay,
  IconBranch
} from './icons'

interface Row {
  icon: JSX.Element
  label: string
  desc: string
}

function Legend({ rows }: { rows: Row[] }): JSX.Element {
  return (
    <div className="legend">
      {rows.map((r) => (
        <div key={r.label} className="legend-row">
          <span className="legend-icon">{r.icon}</span>
          <span className="legend-text">
            <strong>{r.label}</strong>
            <span>{r.desc}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

const swatch = (color: string): JSX.Element => <span className={`legend-dot dot-${color}`} />
const glyph = (text: string, cls = ''): JSX.Element => <span className={`legend-glyph ${cls}`}>{text}</span>

export default function InfoDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const toolbar: Row[] = [
    { icon: <IconSearch />, label: 'Command palette (⌘K)', desc: 'Search to jump to a repo or run any action.' },
    { icon: <IconClipboard />, label: 'Standup digest', desc: 'Your commits across all repos for Today / 24h / 7 days — copyable.' },
    { icon: <IconLayout />, label: 'Switch layout', desc: 'Toggle between the dashboard (cards) and the compact (tiles) view.' },
    { icon: <IconRefresh />, label: 'Refresh', desc: 'Re-fetch every panel right now.' },
    { icon: <IconPlus />, label: 'Import repositories', desc: 'Add local git repos via a folder picker.' },
    { icon: <IconPin filled />, label: 'Pin on top', desc: 'Keep the window floating above other apps (highlighted when on).' }
  ]

  const status: Row[] = [
    { icon: swatch('green'), label: 'Green — up to date', desc: 'Clean working tree, nothing to push.' },
    { icon: swatch('amber'), label: 'Amber — to push / pull', desc: 'Committed ahead of, or behind, the remote.' },
    { icon: swatch('red'), label: 'Red — uncommitted', desc: 'Changed files in the working tree.' },
    { icon: swatch('gray'), label: 'Gray — no upstream / error', desc: 'No tracking branch, or not a git repo.' },
    { icon: glyph('✓', 'ci-pass'), label: 'CI passing', desc: "Latest GitHub Actions run succeeded (needs gh)." },
    { icon: glyph('✕', 'ci-fail'), label: 'CI failing', desc: 'Latest GitHub Actions run failed.' },
    { icon: glyph('…', 'ci-pending'), label: 'CI running', desc: 'A run is queued or in progress.' },
    { icon: <IconBranch />, label: 'Branch · age', desc: 'Current branch and how long since the last commit.' }
  ]

  const meta: Row[] = [
    { icon: <IconStar filled />, label: 'Favorite (star)', desc: 'Pin the repo to the top of its group.' },
    { icon: glyph('#'), label: 'Group', desc: 'Assign a label to organize the dashboard into sections.' },
    { icon: glyph('×'), label: 'Remove', desc: 'Forget the repo in the app — never deletes files on disk.' }
  ]

  const chips: Row[] = [
    { icon: glyph('$', 'chip-live'), label: '$ today', desc: 'Estimated Claude spend today on this project. A green pulse means a session is active right now.' },
    { icon: glyph(':3000', 'chip-server'), label: 'Dev server port', desc: 'A running local server in this repo — click to open it in the browser.' },
    { icon: glyph('2 PRs'), label: 'Open PRs', desc: 'Open pull requests on the repo.' },
    { icon: glyph('1 review', 'chip-attn'), label: 'To review', desc: 'Open PRs that request your review.' },
    { icon: glyph('3 issues'), label: 'Assigned issues', desc: 'Open issues assigned to you.' }
  ]

  const actions: Row[] = [
    { icon: <IconSync />, label: 'Sync', desc: 'Stage all changes, commit, then push the current branch.' },
    { icon: <IconDownload />, label: 'Fetch', desc: 'git fetch origin, so ahead/behind counts stay accurate.' },
    { icon: <IconEditor />, label: 'Open in editor', desc: 'Open the repo in Cursor / VS Code / Zed / Sublime.' },
    { icon: <IconTerminal />, label: 'Open in Terminal', desc: 'Open a Terminal window at the repo.' },
    { icon: <IconFolder />, label: 'Reveal in Finder', desc: 'Show the repo folder in Finder.' },
    { icon: <IconExternal />, label: 'Open on GitHub', desc: "Open the origin remote's web page." },
    { icon: <IconChevron open />, label: 'Expand', desc: 'Show the changed-file list and npm-script buttons.' },
    { icon: <IconPlay />, label: 'Run script', desc: 'Run an npm script (dev / build / test / …) in a new Terminal.' }
  ]

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dialog-info" onClick={(e) => e.stopPropagation()}>
        <h2>What everything means</h2>
        <p className="dialog-sub">A quick legend for the icons, badges, and the Claude cost figures.</p>

        <div className="info-scroll">
          <h3 className="info-h">Toolbar</h3>
          <Legend rows={toolbar} />

          <h3 className="info-h">Repo status &amp; badges</h3>
          <Legend rows={status} />

          <h3 className="info-h">Organize</h3>
          <Legend rows={meta} />

          <h3 className="info-h">Card chips</h3>
          <Legend rows={chips} />

          <h3 className="info-h">Card actions</h3>
          <Legend rows={actions} />

          <h3 className="info-h">Health bar</h3>
          <p className="info-p">
            The strip under the toolbar is a live, at-a-glance summary across every panel: how many
            repos need attention, how many have failing CI, PRs awaiting your review, your estimated
            Claude spend today, sessions active right now, running dev servers, your next calendar
            event, and current CPU / RAM load. Each item only appears when it&apos;s relevant.
          </p>

          <h3 className="info-h">How the dollar values are calculated</h3>
          <p className="info-p">
            The <strong>Claude Code Usage</strong> panel shows estimated cost, computed entirely on
            your machine by reading Claude Code&apos;s local session transcripts in{' '}
            <code>~/.claude/projects</code> (read-only — no network, no credentials). Each assistant
            message records how many tokens it used; we multiply those by current API prices and add
            them up per project.
          </p>

          <div className="info-formula">
            cost = (input×rate<sub>in</sub> + output×rate<sub>out</sub> + cacheWrite×rate<sub>cw</sub>{' '}
            + cacheRead×rate<sub>cr</sub>) ÷ 1,000,000
          </div>

          <p className="info-p">Per-million-token rates by model (cache-write / cache-read shown too):</p>
          <table className="info-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Input</th>
                <th>Output</th>
                <th>Cache write</th>
                <th>Cache read</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Opus</td>
                <td>$15</td>
                <td>$75</td>
                <td>$18.75</td>
                <td>$1.50</td>
              </tr>
              <tr>
                <td>Sonnet</td>
                <td>$3</td>
                <td>$15</td>
                <td>$3.75</td>
                <td>$0.30</td>
              </tr>
              <tr>
                <td>Haiku</td>
                <td>$0.80</td>
                <td>$4</td>
                <td>$1.00</td>
                <td>$0.08</td>
              </tr>
            </tbody>
          </table>
          <p className="info-note">
            The model is read from each message; anything unrecognized is priced at Sonnet rates.
            Cached input is billed at the much cheaper cache-read rate, which is why heavy sessions
            can still be inexpensive.
          </p>

          <h3 className="info-h">Today · This week · All-time</h3>
          <p className="info-p">Each total sums the per-message costs above, filtered by the message timestamp:</p>
          <Legend
            rows={[
              { icon: glyph('Today'), label: 'Today', desc: 'Messages since midnight in your local timezone.' },
              { icon: glyph('Week'), label: 'This week', desc: 'Messages in the last rolling 7 days.' },
              { icon: glyph('All'), label: 'All-time', desc: "Every message in this project's transcripts on disk." }
            ]}
          />
          <p className="info-note">
            These are <strong>cost estimates</strong>, not your plan quota. The progress bars above
            them (Session / Weekly / Opus) come from Claude&apos;s official usage endpoint and remain
            the source of truth for how close you are to your limits.
          </p>
        </div>

        <div className="dialog-actions">
          <button className="primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
