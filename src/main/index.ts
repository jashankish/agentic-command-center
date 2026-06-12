import { app, BrowserWindow, shell, screen, ipcMain } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

// Name the app explicitly so the macOS menu bar (and dock / About panel / the
// userData directory) read "Agentic Command Center" rather than "Electron".
// In dev `app.name` otherwise falls back to Electron's default; packaged builds
// already get this from the bundle's CFBundleName. Must run before app ready.
app.setName('Agentic Command Center')

/** Gap between the main window and a docked panel so each window's native
 *  rounded corners stay clear of the other instead of colliding edge-to-edge. */
const DOCK_GAP = 8

/**
 * Frameless child windows docked to the main window's edges. Each loads the
 * same renderer bundle with a location hash and mounts only that surface
 * (`renderer/src/main.tsx` routes on the hash). Docks claim space outward from
 * the main window in declaration order, falling back to the other side when
 * the display runs out of room, so two open panels never overlap.
 */
interface DockSpec {
  hash: 'feed' | 'terminals'
  width: number
  prefer: 'left' | 'right'
}

const DOCKS: Record<'feed' | 'terminals', DockSpec> = {
  feed: { hash: 'feed', width: 320, prefer: 'right' },
  terminals: { hash: 'terminals', width: 360, prefer: 'left' }
}
const DOCK_ORDER: Array<keyof typeof DOCKS> = ['feed', 'terminals']

let mainWindow: BrowserWindow | null = null
const dockWindows: Partial<Record<keyof typeof DOCKS, BrowserWindow | null>> = {}

/** Route external links to the OS browser; block in-app navigation. Shared by
 *  all windows so none can navigate away or spawn Electron child windows. */
function lockDownNavigation(win: BrowserWindow): void {
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)
    if (url.startsWith('https://') || isLocalhost) shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** Re-dock every visible panel (and `showing`, which is about to become
 *  visible) beside the main window, matching its height. The main window is
 *  never moved or resized — docks are independent surfaces extending beyond it. */
function positionDocks(showing?: keyof typeof DOCKS): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const b = mainWindow.getBounds()
  const { workArea } = screen.getDisplayMatching(b)

  // Outer edge already claimed on each side; panels chain outward from it.
  let rightEdge = b.x + b.width
  let leftEdge = b.x

  for (const key of DOCK_ORDER) {
    const win = dockWindows[key]
    if (!win || win.isDestroyed()) continue
    if (!win.isVisible() && key !== showing) continue
    const spec = DOCKS[key]

    const fitsRight = rightEdge + DOCK_GAP + spec.width <= workArea.x + workArea.width
    const fitsLeft = leftEdge - DOCK_GAP - spec.width >= workArea.x
    let side = spec.prefer
    if (side === 'right' && !fitsRight && fitsLeft) side = 'left'
    if (side === 'left' && !fitsLeft && fitsRight) side = 'right'

    let x: number
    if (side === 'right') {
      x = rightEdge + DOCK_GAP
      rightEdge = x + spec.width
    } else {
      x = leftEdge - DOCK_GAP - spec.width
      leftEdge = x
    }
    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - spec.width))
    win.setBounds({ x, y: b.y, width: spec.width, height: b.height })
  }
}

function createDockWindow(key: keyof typeof DOCKS): BrowserWindow {
  const spec = DOCKS[key]
  const b = mainWindow!.getBounds()
  const win = new BrowserWindow({
    width: spec.width,
    height: b.height,
    x: b.x + b.width + DOCK_GAP,
    y: b.y,
    // Child of the main window: it stays grouped with it (hides on minimize,
    // closes with the app) and always renders above it, but Electron does not
    // move it automatically — we keep it docked via positionDocks().
    parent: mainWindow!,
    show: false,
    frame: false,
    // Keep the default native rounded corners (roundedCorners defaults to true
    // for frameless windows) so docks match the main window's rounded edges.
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#14161b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  // Match the main window's current float state so the group stays together
  // above other apps.
  win.setAlwaysOnTop(mainWindow!.isAlwaysOnTop(), 'floating')
  lockDownNavigation(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${spec.hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: spec.hash })
  }

  win.on('ready-to-show', () => {
    positionDocks(key)
    win.showInactive()
  })

  // Destroyed out from under us (e.g. ⌘W while focused) — drop the reference,
  // tell the main window to un-highlight its toolbar toggle, and let any other
  // open dock reclaim the space.
  win.on('closed', () => {
    dockWindows[key] = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`${key}:closed`)
    }
    positionDocks()
  })

  return win
}

/** Show / hide a docked panel. Returns the resulting open state so the
 *  renderer's toolbar toggle reflects the single source of truth in main. */
function toggleDock(key: keyof typeof DOCKS): boolean {
  if (!mainWindow) return false
  const existing = dockWindows[key]
  if (existing && !existing.isDestroyed()) {
    if (existing.isVisible()) {
      existing.hide()
      positionDocks()
      return false
    }
    positionDocks(key)
    existing.showInactive()
    return true
  }
  dockWindows[key] = createDockWindow(key)
  return true
}

function createWindow(): void {
  // Sized for the dashboard: two columns of project cards with enough height to
  // show the repos, Claude usage, and the full contribution graph at once. We
  // clamp to the display's work area so it always fits on smaller screens, and
  // the window stays freely resizable (reflows to one column when narrowed).
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.min(760, workAreaSize.width)
  const height = Math.min(1340, workAreaSize.height)

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 380,
    minHeight: 460,
    title: 'Agentic Command Center',
    show: false,
    // Solid dark base so the (light-on-dark) UI is always legible. We used to
    // rely on macOS `vibrancy` for the dark backdrop, but on recent macOS the
    // vibrancy view can fail to paint in a packaged app, leaving the light text
    // invisible (a "blank" window). An opaque dark backgroundColor is painted by
    // the window server itself — respecting the rounded corners — so it can't
    // regress. The frosted-glass card surfaces still read as frosted over it.
    backgroundColor: '#14161b',
    // Hide the title bar but keep native rounded corners + traffic lights.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Renderer is fully locked down: isolated context, no Node, sandboxed.
      // The preload only uses contextBridge/ipcRenderer, so sandbox is safe.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow = win

  // Float above other apps' windows by default (toggleable from the toolbar).
  win.setAlwaysOnTop(true, 'floating')

  win.on('ready-to-show', () => win.show())

  // Keep the docked panels glued to the main window as it moves or is resized.
  // 'move' tracks live dragging; 'moved' guarantees the final resting position
  // on platforms that don't stream 'move' continuously.
  const redock = (): void => positionDocks()
  win.on('move', redock)
  win.on('moved', redock)
  win.on('resize', redock)
  win.on('closed', () => {
    mainWindow = null
  })

  lockDownNavigation(win)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()

  ipcMain.handle('feed:toggle', () => toggleDock('feed'))
  ipcMain.handle('terminals:toggle', () => toggleDock('terminals'))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
