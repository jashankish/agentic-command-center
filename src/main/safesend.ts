import type { BrowserWindow } from 'electron'

/**
 * Send an IPC message to a window without ever throwing. During quit Electron
 * can destroy a window's webContents before the window itself (and before the
 * docked panels finish closing), so `win.isDestroyed()` alone isn't enough:
 * `webContents.send` then throws "Object has been destroyed", and an uncaught
 * error in the main process puts up a modal alert that blocks quitting.
 */
export function safeSend(win: BrowserWindow | null | undefined, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    // Torn down between the check and the send — nothing left to update.
  }
}
