import { app, BrowserWindow, shell, screen } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'

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

  // Float above other apps' windows by default (toggleable from the toolbar).
  win.setAlwaysOnTop(true, 'floating')

  win.on('ready-to-show', () => win.show())

  // Defense in depth: the renderer should never navigate away from the app or
  // spawn new windows. Block in-app navigation and route any external links to
  // the OS browser instead of opening them inside an Electron window.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Allow https anywhere, plus http(s) to localhost so dev-server links open.
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)
    if (url.startsWith('https://') || isLocalhost) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
