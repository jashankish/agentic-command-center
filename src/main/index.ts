import { app, BrowserWindow, shell, screen, ipcMain } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

// Name the app explicitly so the macOS menu bar (and dock / About panel / the
// userData directory) read "Agentic Command Center" rather than "Electron".
// In dev `app.name` otherwise falls back to Electron's default; packaged builds
// already get this from the bundle's CFBundleName. Must run before app ready.
app.setName('Agentic Command Center')

/** Width of the docked activity-feed window. */
const FEED_WIDTH = 320
/** Gap between the main window and the feed so each window's native rounded
 *  corners stay clear of the other instead of colliding edge-to-edge. */
const FEED_GAP = 8

let mainWindow: BrowserWindow | null = null
let feedWindow: BrowserWindow | null = null

/** Route external links to the OS browser; block in-app navigation. Shared by
 *  both windows so neither can navigate away or spawn Electron child windows. */
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

/** Dock the feed just off the main window's right edge, matching its height.
 *  Falls back to docking on the left when the main window sits too close to the
 *  right edge of its display to fit the feed. The main window is never moved or
 *  resized — the feed is an independent surface that extends beyond it. */
function positionFeedWindow(): void {
  if (!mainWindow || !feedWindow || feedWindow.isDestroyed()) return
  const b = mainWindow.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  let x = b.x + b.width + FEED_GAP
  if (x + FEED_WIDTH > workArea.x + workArea.width) {
    x = Math.max(workArea.x, b.x - FEED_WIDTH - FEED_GAP)
  }
  feedWindow.setBounds({ x, y: b.y, width: FEED_WIDTH, height: b.height })
}

function createFeedWindow(): BrowserWindow {
  const b = mainWindow!.getBounds()
  const win = new BrowserWindow({
    width: FEED_WIDTH,
    height: b.height,
    x: b.x + b.width + FEED_GAP,
    y: b.y,
    // Child of the main window: it stays grouped with it (hides on minimize,
    // closes with the app) and always renders above it, but Electron does not
    // move it automatically — we keep it docked via positionFeedWindow().
    parent: mainWindow!,
    show: false,
    frame: false,
    // Keep the default native rounded corners (roundedCorners defaults to true
    // for frameless windows) so the feed matches the main window's rounded edges.
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

  // Match the main window's current float state so the pair stays together
  // above other apps.
  win.setAlwaysOnTop(mainWindow!.isAlwaysOnTop(), 'floating')
  lockDownNavigation(win)

  // The renderer entry inspects `#feed` and mounts only the feed surface.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#feed`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'feed' })
  }

  win.on('ready-to-show', () => {
    positionFeedWindow()
    win.showInactive()
  })

  // Destroyed out from under us (e.g. ⌘W while focused) — drop the reference and
  // tell the main window to un-highlight its toolbar toggle.
  win.on('closed', () => {
    feedWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('feed:closed')
  })

  return win
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

  // Keep the docked feed glued to the main window as it moves or is resized.
  const redock = (): void => {
    if (feedWindow && feedWindow.isVisible()) positionFeedWindow()
  }
  // 'move' tracks live dragging; 'moved' guarantees the final resting position
  // on platforms that don't stream 'move' continuously.
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

  // Show / hide the docked feed window. Returns the resulting open state so the
  // renderer's toolbar toggle reflects the single source of truth in main.
  ipcMain.handle('feed:toggle', () => {
    if (!mainWindow) return false
    if (feedWindow && !feedWindow.isDestroyed()) {
      if (feedWindow.isVisible()) {
        feedWindow.hide()
        return false
      }
      positionFeedWindow()
      feedWindow.showInactive()
      return true
    }
    feedWindow = createFeedWindow()
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
