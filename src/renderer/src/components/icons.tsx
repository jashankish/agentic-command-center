// Minimal inline SVG icons (stroke = currentColor) for the toolbar and cards.

interface IconProps {
  size?: number
}

function svg(size: number, children: JSX.Element): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export function IconRefresh({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  )
}

export function IconPlus({ size = 16 }: IconProps): JSX.Element {
  return svg(size, <path d="M12 5v14M5 12h14" />)
}

export function IconPin({ filled, size = 16 }: IconProps & { filled: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5.76l1.92 3.84A1 1 0 0 1 18 17H6a1 1 0 0 1-.92-1.4Z" />
    </svg>
  )
}

export function IconLayout({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </>
  )
}

export function IconGrid({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  )
}

export function IconEditor({ size = 14 }: IconProps): JSX.Element {
  return svg(size, <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />)
}

export function IconTerminal({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </>
  )
}

export function IconFolder({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
  )
}

export function IconExternal({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  )
}

export function IconDownload({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  )
}

export function IconSync({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 21h14" />
    </>
  )
}

export function IconChevron({ open, size = 14 }: IconProps & { open: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export function IconServer({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  )
}

export function IconPlay({ size = 12 }: IconProps): JSX.Element {
  return svg(size, <path d="M6 4v16l13-8Z" />)
}

export function IconBranch({ size = 12 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 3-3 3.5-6 3.5" />
    </>
  )
}

export function IconStar({ filled, size = 14 }: IconProps & { filled: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.3 6.2 21.4l1.1-6.5L2.6 9.8l6.5-.9Z" />
    </svg>
  )
}

export function IconSearch({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  )
}

export function IconBell({ size = 14 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  )
}

export function IconCalendar({ size = 13 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  )
}

export function IconCpu({ size = 13 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  )
}

export function IconInfo({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  )
}

export function IconClipboard({ size = 16 }: IconProps): JSX.Element {
  return svg(
    size,
    <>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2" />
      <path d="M9 12h6M9 16h6" />
    </>
  )
}
