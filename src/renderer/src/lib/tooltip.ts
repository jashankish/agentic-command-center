/**
 * Replaces the browser's slow native title-attribute tooltip with a fast custom one.
 * Tooltip appears after 80 ms instead of the OS default (~500 ms+).
 * Uses a single fixed-position div so it's never clipped by overflow:hidden parents.
 */
export function initTooltips(): void {
  const box = document.createElement('div')
  box.id = 'tt'
  document.body.appendChild(box)

  Object.assign(box.style, {
    position: 'fixed',
    padding: '4px 9px',
    borderRadius: '6px',
    background: 'rgba(12, 15, 20, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.13)',
    color: '#f2f5f8',
    fontSize: '11px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
    lineHeight: '1.45',
    whiteSpace: 'pre-wrap',
    maxWidth: '280px',
    pointerEvents: 'none',
    userSelect: 'none',
    opacity: '0',
    transition: 'opacity 0.1s ease',
    zIndex: '9999',
    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
  } as Partial<CSSStyleDeclaration>)

  let current: Element | null = null
  let storedTitle = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let mx = 0
  let my = 0

  function position(): void {
    const r = box.getBoundingClientRect()
    const left = Math.max(8, Math.min(mx - r.width / 2, window.innerWidth - r.width - 8))
    // Show above cursor when there's room, otherwise below
    const top = my > r.height + 18 ? my - r.height - 10 : my + 18
    box.style.left = `${left}px`
    box.style.top = `${top}px`
  }

  function hide(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (current !== null) {
      if (storedTitle) current.setAttribute('title', storedTitle)
      current.removeAttribute('data-tt-active')
      current = null
      storedTitle = ''
    }
    box.style.opacity = '0'
  }

  // Walk up the DOM to find an ancestor with a non-empty title attribute,
  // or one we're already managing (marked data-tt-active).
  function findTitled(node: Element | null): Element | null {
    while (node && node !== document.documentElement) {
      if (node.hasAttribute('data-tt-active')) return node
      const t = node.getAttribute('title')
      if (t) return node
      node = node.parentElement
    }
    return null
  }

  document.addEventListener(
    'mouseover',
    (e: MouseEvent) => {
      const titled = findTitled(e.target as Element)
      if (titled === current) return
      hide()
      if (!titled) return

      storedTitle = titled.getAttribute('title') ?? ''
      titled.removeAttribute('title') // suppress the native OS tooltip
      titled.setAttribute('data-tt-active', '')
      current = titled

      box.textContent = storedTitle
      // Force layout so getBoundingClientRect is accurate when positioning
      void box.getBoundingClientRect()

      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        box.style.opacity = '1'
        position()
      }, 80)
    },
    true
  )

  document.addEventListener(
    'mouseout',
    (e: MouseEvent) => {
      if (!current) return
      const rt = e.relatedTarget as Element | null
      // Don't hide when entering a child of the current element
      if (rt && (current === rt || current.contains(rt))) return
      hide()
    },
    true
  )

  document.addEventListener(
    'mousemove',
    (e: MouseEvent) => {
      mx = e.clientX
      my = e.clientY
      if (current && parseFloat(box.style.opacity) > 0) position()
    },
    true
  )
}
