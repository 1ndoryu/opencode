import { app, BrowserWindow, ipcMain, webContents } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { write as writeLog } from "./logging"
import { resolveBrowserURL } from "./browser-policy"
import type { BrowserCapture, BrowserPickedElement, BrowserPickResult, BrowserState } from "../preload/types"

// One-shot element picker injected into the guest. Highlights the hovered
// element, resolves with its description on click, resolves null on Escape or
// right-click. The host cancels through CANCEL_PICK_SCRIPT. This is our own
// constant script (no page input), executed only after the user presses the
// picker button in the browser panel.
const PICK_SCRIPT = `(() => {
  if (window.__opencodePickCancel) window.__opencodePickCancel()
  return new Promise((resolve) => {
    const previousCursor = document.documentElement.style.cursor
    let current = null
    const paint = (element) => {
      if (current === element) return
      unpaint()
      current = element
      if (!current || current === document.documentElement) return
      current.__opencodePickOutline = current.style.outline
      current.__opencodePickOffset = current.style.outlineOffset
      current.style.outline = "2px solid #0a84ff"
      current.style.outlineOffset = "1px"
    }
    const unpaint = () => {
      if (!current) return
      current.style.outline = current.__opencodePickOutline ?? ""
      current.style.outlineOffset = current.__opencodePickOffset ?? ""
      delete current.__opencodePickOutline
      delete current.__opencodePickOffset
      current = null
    }
    const selector = (element) => {
      if (element.id) return "#" + CSS.escape(element.id)
      const parts = []
      let node = element
      while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
        let part = node.tagName.toLowerCase()
        const parent = node.parentElement
        if (parent) {
          const same = Array.from(parent.children).filter((sibling) => sibling.tagName === node.tagName)
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")"
        }
        parts.unshift(part)
        node = parent
      }
      parts.unshift("body")
      return parts.join(" > ")
    }
    const cleanup = (value) => {
      document.removeEventListener("mouseover", onOver, true)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("contextmenu", onMenu, true)
      document.removeEventListener("keydown", onKey, true)
      document.documentElement.style.cursor = previousCursor
      unpaint()
      window.__opencodePickCancel = undefined
      resolve(value)
    }
    const onOver = (event) => {
      const target = event.target
      paint(target instanceof Element ? target : null)
    }
    const onClick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const target = event.target
      if (!(target instanceof Element)) {
        cleanup(null)
        return
      }
      const rect = target.getBoundingClientRect()
      const link = target.closest("a")
      cleanup({
        selector: selector(target),
        tagName: target.tagName.toLowerCase(),
        id: target.id ?? "",
        classes: Array.from(target.classList).slice(0, 8),
        text: (target.innerText ?? "").trim().replace(/\\s+/g, " ").slice(0, 200),
        href: link?.href ? String(link.href).slice(0, 500) : "",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
    }
    const onMenu = (event) => {
      event.preventDefault()
      cleanup(null)
    }
    const onKey = (event) => {
      if (event.key === "Escape") cleanup(null)
    }
    window.__opencodePickCancel = () => cleanup(null)
    document.documentElement.style.cursor = "crosshair"
    document.addEventListener("mouseover", onOver, true)
    document.addEventListener("click", onClick, true)
    document.addEventListener("contextmenu", onMenu, true)
    document.addEventListener("keydown", onKey, true)
  })
})()`

const CANCEL_PICK_SCRIPT = `window.__opencodePickCancel?.()`

// Failsafe: a picker left open (tab hidden, guest crashed) resolves null.
const PICK_TIMEOUT_MS = 90_000

// One pending pick per host window, keyed by host webContents id.
const picks = new Map<number, () => void>()

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
  ipcMain.handle("browser-pick", (event: IpcMainInvokeEvent) => pickElement(event))
  ipcMain.handle("browser-pick-cancel", (event: IpcMainInvokeEvent) => {
    const host = requireHost(event)
    picks.get(host.webContents.id)?.()
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

async function pickElement(event: IpcMainInvokeEvent): Promise<BrowserPickResult | null> {
  const host = requireHost(event)
  const guest = requireGuest(event)
  const hostId = host.webContents.id
  // A new pick cancels a previous one left pending for this host.
  picks.get(hostId)?.()
  let cancel: (() => void) | undefined
  const cancelled = new Promise<null>((resolve) => {
    cancel = () => resolve(null)
  })
  const stop = () => cancel?.()
  picks.set(hostId, stop)
  const expired = new Promise<null>((resolve) => {
    setTimeout(() => {
      void guest.executeJavaScript(CANCEL_PICK_SCRIPT, true).catch(() => undefined)
      resolve(null)
    }, PICK_TIMEOUT_MS)
  })
  try {
    const picked = await Promise.race([
      guest
        .executeJavaScript(PICK_SCRIPT, true)
        .then((value) => value as BrowserPickedElement | null)
        .catch(() => null),
      cancelled,
      expired,
    ])
    if (!picked || typeof picked.selector !== "string") return null
    const capture = await captureElement(guest, picked.rect).catch(() => null)
    return {
      element: { ...picked, url: guest.getURL(), title: guest.getTitle() },
      capture,
    }
  } finally {
    if (picks.get(hostId) === stop) picks.delete(hostId)
  }
}

async function captureElement(
  guest: WebContents,
  rect: { x: number; y: number; width: number; height: number },
): Promise<BrowserCapture | null> {
  const clip = {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height)),
  }
  const image = await guest.capturePage(clip)
  if (image.isEmpty()) return null
  const size = image.getSize()
  return {
    buffer: new Uint8Array(image.toPNG()).slice().buffer,
    width: size.width,
    height: size.height,
  }
}

function pushState(host: WebContents, guest: WebContents) {
  if (host.isDestroyed() || guest.isDestroyed()) return
  host.send("browser-state", readState(guest))
}
