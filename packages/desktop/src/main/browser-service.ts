import { app, BrowserWindow, ipcMain, webContents } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { write as writeLog } from "./logging"
import { resolveBrowserURL } from "./browser-policy"
import type { BrowserCapture, BrowserState } from "../preload/types"

// WebContents overloads do not accept a union of event names, so attach and
// detach spell the same set out through these two helpers.
function wireGuestState(guest: WebContents, push: () => void) {
  guest.on("did-start-loading", push)
  guest.on("did-stop-loading", push)
  guest.on("did-navigate", push)
  guest.on("did-navigate-in-page", push)
  guest.on("page-title-updated", push)
  guest.on("did-fail-load", push)
}

function unwireGuestState(guest: WebContents) {
  guest.removeAllListeners("did-start-loading")
  guest.removeAllListeners("did-stop-loading")
  guest.removeAllListeners("did-navigate")
  guest.removeAllListeners("did-navigate-in-page")
  guest.removeAllListeners("page-title-updated")
  guest.removeAllListeners("did-fail-load")
}

// One guest per host window, keyed by host webContents id. The renderer owns
// the <webview> tag; main tracks the guest after the panel reports its id.
const guests = new Map<number, WebContents>()
let initialized = false

export function registerBrowserIpcHandlers() {
  if (initialized) return
  initialized = true

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return
    contents.setWindowOpenHandler(({ url }) => {
      writeLog("browser", "denied guest popup", { url }, "warn")
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (resolveBrowserURL(url)) return
      event.preventDefault()
      writeLog("browser", "blocked guest navigation", { url }, "warn")
    })
  })

  ipcMain.handle("browser-attach", (event: IpcMainInvokeEvent, guestId: number) =>
    attachGuest(event, guestId),
  )
  ipcMain.handle("browser-detach", (event: IpcMainInvokeEvent) => detachGuest(event))
  ipcMain.handle("browser-navigate", (event: IpcMainInvokeEvent, url: string) => {
    const guest = requireGuest(event)
    const target = resolveBrowserURL(url)
    if (!target) throw new Error("Invalid browser URL")
    void guest.loadURL(target)
    return readState(guest)
  })
  ipcMain.handle("browser-back", (event: IpcMainInvokeEvent) => {
    const guest = requireGuest(event)
    if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
    return readState(guest)
  })
  ipcMain.handle("browser-forward", (event: IpcMainInvokeEvent) => {
    const guest = requireGuest(event)
    if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
    return readState(guest)
  })
  ipcMain.handle("browser-reload", (event: IpcMainInvokeEvent) => {
    const guest = requireGuest(event)
    guest.reload()
    return readState(guest)
  })
  ipcMain.handle("browser-stop", (event: IpcMainInvokeEvent) => {
    const guest = requireGuest(event)
    guest.stop()
    return readState(guest)
  })
  ipcMain.handle("browser-state", (event: IpcMainInvokeEvent) => {
    const guest = guests.get(event.sender.id)
    if (!guest || guest.isDestroyed()) {
      guests.delete(event.sender.id)
      return null
    }
    return readState(guest)
  })
  ipcMain.handle("browser-capture", async (event: IpcMainInvokeEvent) => {
    const guest = requireGuest(event)
    const image = await guest.capturePage()
    if (image.isEmpty()) return null
    const size = image.getSize()
    const capture: BrowserCapture = {
      buffer: new Uint8Array(image.toPNG()).slice().buffer,
      width: size.width,
      height: size.height,
    }
    return capture
  })
  ipcMain.handle("browser-zoom", (event: IpcMainInvokeEvent, factor: number) => {
    const guest = requireGuest(event)
    if (!Number.isFinite(factor)) throw new Error("Invalid browser zoom")
    guest.setZoomFactor(Math.min(5, Math.max(0.25, factor)))
    return readState(guest)
  })
}

function attachGuest(event: IpcMainInvokeEvent, guestId: number) {
  const host = requireHost(event)
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview") {
    throw new Error("Browser guest not found")
  }
  if (guest.hostWebContents !== host.webContents) throw new Error("Browser guest host mismatch")
  detachGuest(event)
  guests.set(host.webContents.id, guest)
  wireGuestState(guest, () => pushState(host.webContents, guest))
  guest.once("destroyed", () => {
    guests.delete(host.webContents.id)
    if (!host.webContents.isDestroyed()) host.webContents.send("browser-state", null)
  })
  writeLog("browser", "guest attached", { guest: guest.id })
  return readState(guest)
}

function detachGuest(event: IpcMainInvokeEvent) {
  const host = requireHost(event)
  const guest = guests.get(host.webContents.id)
  guests.delete(host.webContents.id)
  if (guest && !guest.isDestroyed()) unwireGuestState(guest)
}

function requireGuest(event: IpcMainInvokeEvent) {
  const host = requireHost(event)
  const guest = guests.get(host.webContents.id)
  if (!guest || guest.isDestroyed()) {
    guests.delete(host.webContents.id)
    throw new Error("Browser not attached")
  }
  return guest
}

function requireHost(event: IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Invalid browser sender")
  }
  return win
}

function readState(guest: WebContents): BrowserState {
  return {
    url: guest.getURL(),
    title: guest.getTitle(),
    loading: guest.isLoading(),
    canGoBack: guest.navigationHistory.canGoBack(),
    canGoForward: guest.navigationHistory.canGoForward(),
  }
}

function pushState(host: WebContents, guest: WebContents) {
  if (host.isDestroyed() || guest.isDestroyed()) return
  host.send("browser-state", readState(guest))
}
