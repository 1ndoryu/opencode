import { app, BrowserWindow, ipcMain, webContents } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { write as writeLog } from "./logging"
import { resolveBrowserURL } from "./browser-policy"
import type {
  BrowserCapture,
  BrowserConsoleEntry,
  BrowserPickedElement,
  BrowserPickResult,
  BrowserSnapshot,
  BrowserSnapshotNode,
  BrowserState,
} from "../preload/types"

// Shared element->selector builder, interpolated into PICK_SCRIPT and
// SNAPSHOT_SCRIPT so both stay in sync. Walks the FULL chain to <body>
// (no level cap: a capped chain with ">" asserts direct-child links that
// skip levels and querySelector returns null — that was the "no match" bug
// in act click/scroll and the invalid picker selectors). Prefers #id but
// verifies it in-page (duplicate ids resolve to the wrong element).
const SELECTOR_FN = `(element) => {
  if (element.id) {
    const byId = "#" + CSS.escape(element.id)
    try {
      if (document.querySelector(byId) === element) return byId
    } catch (ignored) {}
  }
  const parts = []
  let node = element
  while (node && node.nodeType === 1 && node !== document.body) {
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
}`

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
    const selector = ${SELECTOR_FN}
    const implicitRole = (element) => {
      const tag = element.tagName.toLowerCase()
      if (tag === "a" && element.hasAttribute("href")) return "link"
      if (tag === "button") return "button"
      if (tag === "img") return "img"
      if (/^h[1-6]$/.test(tag)) return "heading"
      if (tag === "input") {
        const type = (element.getAttribute("type") || "text").toLowerCase()
        if (type === "checkbox") return "checkbox"
        if (type === "radio") return "radio"
        if (type === "submit" || type === "button") return "button"
        return "textbox"
      }
      if (tag === "textarea") return "textbox"
      if (tag === "select") return "combobox"
      if (tag === "form") return "form"
      if (tag === "nav") return "navigation"
      if (tag === "main") return "main"
      return ""
    }
    const label = (element) => {
      const parts = [element.tagName.toLowerCase()]
      if (element.id) parts.push("#" + element.id)
      else if (element.classList.length > 0) parts.push("." + Array.from(element.classList).slice(0, 2).join("."))
      return parts.join("")
    }
    const xpathOf = (element) => {
      if (element.id) return "//" + element.tagName.toLowerCase() + "[@id=" + JSON.stringify(element.id) + "]"
      const parts = []
      let node = element
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        let part = node.tagName.toLowerCase()
        const parent = node.parentElement
        if (parent) {
          const same = Array.from(parent.children).filter((sibling) => sibling.tagName === node.tagName)
          if (same.length > 1) part += "[" + (same.indexOf(node) + 1) + "]"
        }
        parts.unshift(part)
        node = parent
      }
      return "/" + parts.join("/")
    }
    const ancestorsOf = (element) => {
      const chain = []
      let node = element.parentElement
      while (node && node.nodeType === 1 && node !== document.body && chain.length < 6) {
        chain.unshift(label(node))
        node = node.parentElement
      }
      return chain
    }
    const ATTRS = ["type", "name", "value", "placeholder", "role", "aria-label", "alt", "title", "target", "for", "data-testid"]
    const attrsOf = (element) => {
      const picked = {}
      let count = 0
      for (const name of ATTRS) {
        if (count >= 10) break
        const value = element.getAttribute(name)
        if (value === null || value === "") continue
        picked[name] = value.slice(0, 200)
        count++
      }
      return picked
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
      // Unpaint first: outerHTML must not leak the picker highlight style.
      unpaint()
      cleanup({
        selector: selector(target),
        xpath: xpathOf(target),
        role: target.getAttribute("role") || implicitRole(target),
        ancestors: ancestorsOf(target),
        attributes: attrsOf(target),
        outerHtml: (target.outerHTML ?? "").slice(0, 2000),
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

const CONSOLE_LEVELS = ["verbose", "info", "warning", "error"]

// Last page console entries per host window, keyed by host webContents id.
const CONSOLE_LIMIT = 200
const consoleLogs = new Map<number, BrowserConsoleEntry[]>()

// Latest snapshot ref->selector map per guest, keyed by guest webContents id.
// Refs are only valid until the next snapshot for the same guest.
const snapshotRefs = new Map<number, Map<number, string>>()

// Compact actionable tree for the agent (snapshot-first: text, no images).
// Refs are positional per snapshot; the host keeps the ref->selector map so
// follow-up actions never re-send HTML.
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = 150
  const ACTIONABLE = "a[href], button, input, select, textarea, [role='button'], [role='link'], [role='checkbox'], [role='textbox'], [role='combobox'], [role='menuitem'], [contenteditable='true']"
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH"])
  const seen = new Set()
  const nodes = []
  const label = (element) => {
    const parts = [element.tagName.toLowerCase()]
    if (element.id) parts.push("#" + element.id)
    else if (element.classList.length > 0) parts.push("." + Array.from(element.classList).slice(0, 2).join("."))
    return parts.join("")
  }
  const selector = ${SELECTOR_FN}
  const nameOf = (element) => {
    const raw =
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      (element.innerText ?? "").trim().replace(/\\s+/g, " ") ||
      (element.value ?? "")
    return String(raw).slice(0, 80)
  }
  const roleOf = (element) => {
    if (element.getAttribute("role")) return element.getAttribute("role")
    const tag = element.tagName.toLowerCase()
    if (tag === "a") return "link"
    if (tag === "button") return "button"
    if (tag === "input") return "textbox"
    if (tag === "textarea") return "textbox"
    if (tag === "select") return "combobox"
    return tag
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      if (SKIP.has(node.tagName)) return NodeFilter.FILTER_REJECT
      const style = node.getBoundingClientRect ? node.getBoundingClientRect() : null
      if (style && (style.width === 0 || style.height === 0)) return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let truncated = false
  let current = walker.currentNode
  while (current) {
    if (current.matches && current.matches(ACTIONABLE) && !seen.has(current)) {
      seen.add(current)
      if (nodes.length >= MAX_NODES) {
        truncated = true
        break
      }
      nodes.push({ role: roleOf(current), name: nameOf(current), selector: selector(current), label: label(current) })
    }
    current = walker.nextNode()
  }
  return { nodes, truncated }
})()`

const ACT_SCRIPT = `((selector, action, text) => {
  const element = document.querySelector(selector)
  if (!element) return { ok: false, error: "no match for " + selector }
  const tag = element.tagName.toLowerCase()
  if (action === "click") {
    element.click()
    return { ok: true }
  }
  if (action === "focus") {
    element.focus()
    return { ok: true }
  }
  if (action === "hover") {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    return { ok: true }
  }
  if (action === "scroll") {
    element.scrollIntoView({ block: "center" })
    return { ok: true }
  }
  if (action === "fill") {
    if (tag === "select") {
      element.value = text ?? ""
      element.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true }
    }
    if (tag === "input" && (element.type === "checkbox" || element.type === "radio")) {
      element.checked = true
      element.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true }
    }
    element.focus()
    element.value = text ?? ""
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return { ok: true }
  }
  return { ok: false, error: "unknown action" }
})`

const EVALUATE_TIMEOUT_MS = 15_000

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
  guest.removeAllListeners("console-message")
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
  consoleLogs.set(host.webContents.id, [])
  wireGuestState(guest, () => pushState(host.webContents, guest))
  guest.on("console-message", (_event, level, message, line, sourceId) => {
    const entries = consoleLogs.get(host.webContents.id) ?? []
    entries.push({
      level: CONSOLE_LEVELS[level] ?? `level${level}`,
      message: String(message).slice(0, 1000),
      line,
      sourceId: String(sourceId).slice(-120),
      ts: Date.now(),
    })
    consoleLogs.set(host.webContents.id, entries.slice(-CONSOLE_LIMIT))
  })
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
  consoleLogs.delete(host.webContents.id)
  if (guest && !guest.isDestroyed()) {
    snapshotRefs.delete(guest.id)
    unwireGuestState(guest)
  }
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

// Agent-facing surface (used by the sidecar bridge, not the renderer).
// Tools act on the focused window's guest so the model sees the page the
// user is looking at; without an attached guest every call fails closed.

export function getActiveGuest(): { hostId: number; guest: WebContents } | null {
  for (const [hostId, guest] of guests) {
    if (!guest.isDestroyed()) continue
    guests.delete(hostId)
    consoleLogs.delete(hostId)
  }
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.webContents.isDestroyed()) {
    const guest = guests.get(focused.webContents.id)
    if (guest && !guest.isDestroyed()) return { hostId: focused.webContents.id, guest }
  }
  const first = guests.entries().next()
  if (!first.done) return { hostId: first.value[0], guest: first.value[1] }
  return null
}

export function readGuestState(guest: WebContents): BrowserState {
  return readState(guest)
}

export function readConsole(hostId: number, limit = 100): BrowserConsoleEntry[] {
  return (consoleLogs.get(hostId) ?? []).slice(-Math.max(1, Math.min(200, limit)))
}

export function clearConsole(hostId: number) {
  consoleLogs.set(hostId, [])
}

export async function navigateGuest(guest: WebContents, url: string): Promise<BrowserState> {
  const target = resolveBrowserURL(url)
  if (!target) throw new Error("Invalid browser URL")
  const settled = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 30_000)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    guest.once("did-stop-loading", done)
    guest.once("did-fail-load", done)
  })
  await guest.loadURL(target)
  await settled
  return readState(guest)
}

export function controlGuest(guest: WebContents, action: "back" | "forward" | "reload" | "stop"): BrowserState {
  if (action === "back" && guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
  if (action === "forward" && guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
  if (action === "reload") guest.reload()
  if (action === "stop") guest.stop()
  return readState(guest)
}

export async function takeSnapshot(guest: WebContents): Promise<BrowserSnapshot> {
  const raw = (await guest.executeJavaScript(SNAPSHOT_SCRIPT, true).catch(() => null)) as {
    nodes?: { role: string; name: string; selector: string; label: string }[]
    truncated?: boolean
  } | null
  const refs = new Map<number, string>()
  const nodes: BrowserSnapshotNode[] = (raw?.nodes ?? []).map((node, index) => {
    refs.set(index, node.selector)
    return { ref: index, role: node.role, name: node.name, selector: node.selector }
  })
  snapshotRefs.set(guest.id, refs)
  return { url: guest.getURL(), title: guest.getTitle(), nodes, truncated: raw?.truncated ?? false }
}

export async function actOnRef(
  guest: WebContents,
  ref: number,
  action: "click" | "fill" | "focus" | "hover" | "scroll",
  text?: string,
): Promise<{ ok: boolean; error?: string }> {
  const selector = snapshotRefs.get(guest.id)?.get(ref)
  if (!selector) throw new Error("Stale browser ref — take a new snapshot first")
  const result = (await guest
    .executeJavaScript(`(${ACT_SCRIPT})(${JSON.stringify(selector)}, ${JSON.stringify(action)}, ${JSON.stringify(text ?? "")})`, true)
    .catch(() => null)) as { ok: boolean; error?: string } | null
  if (!result) throw new Error("Browser action failed")
  return result
}

export async function evaluateInGuest(guest: WebContents, js: string): Promise<string> {
  if (js.length > 4000) throw new Error("Browser script too long (max 4000 chars)")
  const wrapped = `Promise.resolve().then(async () => (${js})).then(
    (value) => ({ json: JSON.stringify(value)?.slice(0, 20000) ?? String(value).slice(0, 20000) }),
    (error) => ({ error: String(error?.message ?? error).slice(0, 2000) }),
  )`
  const timeout = new Promise<{ error: string }>((resolve) => {
    setTimeout(() => resolve({ error: "Script timed out after 15s" }), EVALUATE_TIMEOUT_MS)
  })
  const result = (await Promise.race([
    guest.executeJavaScript(wrapped, true).catch((error: unknown) => ({ error: String(error).slice(0, 2000) })),
    timeout,
  ])) as { json?: string; error?: string }
  if (result.error) throw new Error(result.error)
  return result.json ?? "undefined"
}

export async function captureFull(guest: WebContents): Promise<BrowserCapture | null> {
  const image = await guest.capturePage()
  if (image.isEmpty()) return null
  const size = image.getSize()
  return {
    buffer: new Uint8Array(image.toPNG()).slice().buffer,
    width: size.width,
    height: size.height,
  }
}
