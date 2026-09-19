import { app, BrowserWindow, ipcMain, webContents } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { write as writeLog } from "./logging"
import { resolveBrowserURL } from "./browser-policy"
import { chooseAgentTabId, isValidSessionID, isValidTabId, pinSession, pinnedKey, tabKey } from "./browser-tabs"
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

// Shared depth-from-<body> helper, interpolated into PICK_SCRIPT and
// SNAPSHOT_SCRIPT so both stay in sync. Capped: deep ad-iframes would
// otherwise push the agent-side indent off the page. Lives here (not
// inline in one script) so SNAPSHOT_SCRIPT never hits "depthOf is not
// defined" — that ReferenceError nulled the whole snapshot (empty list
// with valid title/URL) on wp-login and similar pages.
const DEPTH_FN = `(element) => {
  let depth = 0
  let node = element.parentElement
  while (node && node !== document.body && depth < 32) {
    depth += 1
    node = node.parentElement
  }
  return depth
}`

// One-shot element picker injected into the guest. Highlights the hovered
// element with a follower tooltip (exact tag#id/.classes), resolves with its
// description on mousedown, resolves null on Escape or right-click. The host
// cancels through CANCEL_PICK_SCRIPT. This is our own constant script (no
// page input), executed only after the user presses the picker button in the
// browser panel.
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
  // Depth from <body> for agent-side indentation (compact format has no
  // selector column, so nesting is the only structure cue).
  const depthOf = ${DEPTH_FN}
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
    // Follower tooltip: shows the exact tag#id/.classes under the cursor so
    // the user sees what a press would pick. pointer-events:none keeps it out
    // of hit-testing; it lives on <html> (not <body>) and describe() removes
    // it before reading outerHTML, so the payload never leaks it.
    const tip = document.createElement("div")
    tip.setAttribute("data-opencode-pick-tip", "true")
    tip.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
      "font:11px/14px monospace,monospace;color:#fff;background:rgba(20,20,25,0.92);" +
      "border:1px solid #0a84ff;border-radius:4px;padding:2px 6px;max-width:320px;" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
    document.documentElement.appendChild(tip)
    const showTip = (element, x, y) => {
      if (!element) {
        tip.style.display = "none"
        return
      }
      tip.textContent = label(element)
      tip.style.display = "block"
      tip.style.left = x + 14 + "px"
      tip.style.top = y + 16 + "px"
    }
    const cleanup = (value) => {
      document.removeEventListener("mouseover", onOver, true)
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("mousedown", onDown, true)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("contextmenu", onMenu, true)
      document.removeEventListener("keydown", onKey, true)
      document.documentElement.style.cursor = previousCursor
      unpaint()
      tip.style.display = "none"
      tip.remove()
      window.__opencodePickCancel = undefined
      resolve(value)
    }
    const onOver = (event) => {
      const target = event.target
      paint(target instanceof Element ? target : null)
    }
    const onMove = (event) => {
      if (current && current !== document.documentElement) showTip(current, event.clientX, event.clientY)
      else tip.style.display = "none"
    }
    const describe = (target) => {
      // Drop the tip first: outerHTML must not leak it when the picked
      // element is <body> or <html>.
      tip.remove()
      const rect = target.getBoundingClientRect()
      const link = target.closest("a")
      // Unpaint first: outerHTML must not leak the picker highlight style.
      unpaint()
      return {
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
      }
    }
    // Resolve on mousedown, not click: dismissible menus/popups close on
    // mousedown (their outside-click handler removes the node), so by click
    // time the event retargets to whatever is underneath — usually <html>.
    // Capture runs before the page's own dismiss handler. Non-left buttons
    // fall through so right-click still cancels via onMenu. Click stays as
    // fallback for keyboard-triggered activation (Enter), which fires click
    // with no preceding mousedown.
    const onDown = (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const target = event.target
      if (!(target instanceof Element)) {
        cleanup(null)
        return
      }
      cleanup(describe(target))
    }
    const onClick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const target = event.target
      if (!(target instanceof Element)) {
        cleanup(null)
        return
      }
      cleanup(describe(target))
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
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("mousedown", onDown, true)
    document.addEventListener("click", onClick, true)
    document.addEventListener("contextmenu", onMenu, true)
    document.addEventListener("keydown", onKey, true)
  })
})()`

const CANCEL_PICK_SCRIPT = `window.__opencodePickCancel?.()`

// Failsafe: a picker left open (tab hidden, guest crashed) resolves null.
const PICK_TIMEOUT_MS = 90_000

const CONSOLE_LEVELS = ["verbose", "info", "warning", "error"]

// Last page console entries per browser tab, keyed by "hostId:tabId".
const CONSOLE_LIMIT = 200
const consoleLogs = new Map<string, BrowserConsoleEntry[]>()

// Latest snapshot ref->selector map per guest, keyed by guest webContents id.
// Refs are only valid until the next snapshot for the same guest.
const snapshotRefs = new Map<number, Map<number, string>>()

// Signature of the last successful snapshot per guest, keyed the same way.
// After an act with no page change main reports unchanged:true so the agent
// is not re-sent the full list (VS Code returns the literal "<unchanged>").
const snapshotSig = new Map<number, string>()

function signatureOf(nodes: { role: string; name: string }[]): string {
  let hash = 5381
  for (const node of nodes) {
    const line = `${node.role}|${node.name}\n`
    for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0
  }
  return String(hash)
}

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
  const depthOf = ${DEPTH_FN}
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
      nodes.push({ role: roleOf(current), name: nameOf(current), selector: selector(current), label: label(current), depth: depthOf(current) })
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

// One pending pick per browser tab, keyed by "hostId:tabId".
const picks = new Map<string, () => void>()

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

// One guest per browser tab, keyed by "hostId:tabId" (tab ids repeat across
// windows). The renderer owns the <webview> tags; main tracks each guest after
// the panel reports its id, plus which tab is selected per window and which
// tab each agent session pinned (so conversation B never clobbers A's page).
const guests = new Map<string, WebContents>()
const selectedTab = new Map<number, string>()
const sessionPins = new Map<string, string>()
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

  ipcMain.handle("browser-attach", (event: IpcMainInvokeEvent, guestId: number, tabId: string) =>
    attachGuest(event, guestId, tabId),
  )
  ipcMain.handle("browser-detach", (event: IpcMainInvokeEvent, tabId?: string) => {
    return detachGuest(event, tabId)
  })
  ipcMain.handle("browser-select", (event: IpcMainInvokeEvent, tabId: string) => {
    const host = requireHost(event)
    if (!isValidTabId(tabId)) throw new Error("Invalid browser tab")
    selectedTab.set(host.webContents.id, tabId)
  })
  // The panel pins the active conversation to its tab, so the agent for that
  // session defaults to the page the user is looking at. Pins are validated
  // against live guests on read, so pinning an unattached tab is harmless.
  ipcMain.handle("browser-pin-session", (event: IpcMainInvokeEvent, sessionID: string, tabId: string) => {
    const host = requireHost(event)
    if (!isValidSessionID(sessionID) || !isValidTabId(tabId)) throw new Error("Invalid browser session pin")
    pinSession(sessionPins, sessionID, tabKey(host.webContents.id, tabId))
  })
  // Closing a tab keeps the shared cookie jar (OP-28): every tab persists in
  // BROWSER_SHARED_PARTITION, so wiping here would log every other tab out.
  // The renderer destroys the webview and main forgets the guest; the jar
  // survives closes and restarts at
  // %APPDATA%/ai.opencode.desktop.propio/Partitions/propio-browser-shared.
  // Panel teardown uses browser-detach instead, which also preserves the jar.
  ipcMain.handle("browser-close-tab", (event: IpcMainInvokeEvent, tabId: string) => {
    const host = requireHost(event)
    if (!isValidTabId(tabId)) throw new Error("Invalid browser tab")
    const hostId = host.webContents.id
    const key = tabKey(hostId, tabId)
    detachTab(hostId, key)
    for (const [sessionID, pinned] of sessionPins) {
      if (pinned === key) sessionPins.delete(sessionID)
    }
  })
  ipcMain.handle("browser-navigate", (event: IpcMainInvokeEvent, url: string, tabId?: string) => {
    // The panel restores background tabs without focusing them; toolbar and
    // agent navigation omit tabId and target the selected tab as before.
    const guest = tabId === undefined ? requireGuest(event) : tabGuest(event, tabId)
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
    const guest = selectedGuest(event.sender.id)
    if (!guest) return null
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
    const key = selectedKey(event.sender.id)
    if (key) picks.get(key)?.()
  })
}

function attachGuest(event: IpcMainInvokeEvent, guestId: number, tabId: string) {
  const host = requireHost(event)
  if (!isValidTabId(tabId)) throw new Error("Invalid browser tab")
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview") {
    throw new Error("Browser guest not found")
  }
  if (guest.hostWebContents !== host.webContents) throw new Error("Browser guest host mismatch")
  const hostId = host.webContents.id
  const key = tabKey(hostId, tabId)
  detachTab(hostId, key)
  guests.set(key, guest)
  consoleLogs.set(key, [])
  if (!selectedTab.has(hostId)) selectedTab.set(hostId, tabId)
  wireGuestState(guest, () => pushState(host.webContents, tabId, guest))
  guest.on("console-message", (_event, level, message, line, sourceId) => {
    const entries = consoleLogs.get(key) ?? []
    entries.push({
      level: CONSOLE_LEVELS[level] ?? `level${level}`,
      message: String(message).slice(0, 1000),
      line,
      sourceId: String(sourceId).slice(-120),
      ts: Date.now(),
    })
    consoleLogs.set(key, entries.slice(-CONSOLE_LIMIT))
  })
  guest.once("destroyed", () => {
    detachTab(hostId, key)
    if (!host.webContents.isDestroyed()) host.webContents.send("browser-state", { tabId, state: null })
  })
  writeLog("browser", "guest attached", { guest: guest.id, tab: tabId })
  return readState(guest)
}

function detachTab(hostId: number, key: string) {
  const guest = guests.get(key)
  guests.delete(key)
  consoleLogs.delete(key)
  if (guest && !guest.isDestroyed()) {
    snapshotRefs.delete(guest.id)
    snapshotSig.delete(guest.id)
    unwireGuestState(guest)
  }
}

function detachGuest(event: IpcMainInvokeEvent, tabId?: string) {
  const host = requireHost(event)
  const hostId = host.webContents.id
  // Closing the panel detaches every tab; closing one tab names it.
  if (tabId !== undefined && !isValidTabId(tabId)) throw new Error("Invalid browser tab")
  for (const key of [...guests.keys()]) {
    if (!key.startsWith(`${hostId}:`)) continue
    if (tabId !== undefined && key !== tabKey(hostId, tabId)) continue
    detachTab(hostId, key)
  }
  if (tabId === undefined) selectedTab.delete(hostId)
}

function requireGuest(event: IpcMainInvokeEvent) {
  const host = requireHost(event)
  const guest = selectedGuest(host.webContents.id)
  if (!guest) throw new Error("Browser not attached")
  return guest
}

function tabGuest(event: IpcMainInvokeEvent, tabId: string) {
  const host = requireHost(event)
  if (!isValidTabId(tabId)) throw new Error("Invalid browser tab")
  const guest = guests.get(tabKey(host.webContents.id, tabId))
  if (!guest || guest.isDestroyed()) throw new Error("Browser not attached")
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
  const key = tabKey(host.webContents.id, selectedTab.get(host.webContents.id) ?? "")
  // A new pick cancels a previous one left pending for this tab.
  picks.get(key)?.()
  let cancel: (() => void) | undefined
  const cancelled = new Promise<null>((resolve) => {
    cancel = () => resolve(null)
  })
  const stop = () => cancel?.()
  picks.set(key, stop)
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
    if (picks.get(key) === stop) picks.delete(key)
  }
}

const CAPTURE_RETRY_MS = 300

// Chromium throws UnknownVizError (or returns an empty image) when the
// guest has no display surface: hidden/minimized window, backgrounded
// <webview>, zero-size clip. One short retry absorbs the transient case;
// a persistent failure returns null so the caller can report the
// actionable hint (bring Navegador front, unminimize, retry).
async function tryCapturePage(guest: WebContents, clip?: { x: number; y: number; width: number; height: number }) {
  try {
    return await guest.capturePage(clip)
  } catch (error) {
    writeLog("browser", "capturePage failed, retrying once", { error: String(error).slice(0, 300) }, "warn")
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS))
    try {
      return await guest.capturePage(clip)
    } catch (retryError) {
      writeLog("browser", "capturePage retry failed", { error: String(retryError).slice(0, 300) }, "warn")
      return null
    }
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
  const image = await tryCapturePage(guest, clip)
  if (!image || image.isEmpty()) return null
  const size = image.getSize()
  return {
    buffer: new Uint8Array(image.toPNG()).slice().buffer,
    width: size.width,
    height: size.height,
  }
}

function pushState(host: WebContents, tabId: string, guest: WebContents) {
  if (host.isDestroyed() || guest.isDestroyed()) return
  host.send("browser-state", { tabId, state: readState(guest) })
}

/** Live guest for a host's selected tab (prunes destroyed guests). */
function selectedGuest(hostId: number): WebContents | null {
  const key = selectedKey(hostId)
  if (!key) return null
  const guest = guests.get(key) ?? null
  if (guest && !guest.isDestroyed()) return guest
  detachTab(hostId, key)
  return null
}

function selectedKey(hostId: number): string | null {
  const tabId = selectedTab.get(hostId)
  if (!tabId) return null
  return tabKey(hostId, tabId)
}

// Agent-facing surface (used by the sidecar bridge, not the renderer).
// Sessions pin to the tab they first touched so parallel conversations keep
// their own page. Without a pin the agent keeps the selected tab when nobody
// else pinned it, else takes a tab no other session pinned; borrowing a
// foreign pinned tab is the last resort and gets logged. Acting on a
// background tab reports selected:false so the bridge can flip the panel to
// the tab the agent touched. Without any guest, fails closed.
export type AgentGuest = {
  hostId: number
  tabId: string
  guest: WebContents
  selected: boolean
  sessionID: string | undefined
}

function pruneGuests() {
  for (const [key, guest] of guests) {
    if (guest.isDestroyed()) {
      guests.delete(key)
      consoleLogs.delete(key)
    }
  }
}

function hostTabEntries(hostId: number): { tabId: string; guest: WebContents }[] {
  const prefix = `${hostId}:`
  const entries: { tabId: string; guest: WebContents }[] = []
  for (const [key, guest] of guests) {
    if (!key.startsWith(prefix) || guest.isDestroyed()) continue
    entries.push({ tabId: key.slice(prefix.length), guest })
  }
  return entries
}

// Whether any <webview> guest is attached (after pruning the destroyed
// ones). Lets the bridge tell "browser closed" apart from "pages open but
// none may serve this session" (NO_AGENT_TAB).
export function hasAttachedTabs(): boolean {
  pruneGuests()
  return guests.size > 0
}

export function resolveAgentGuest(params: { tabId?: unknown; sessionID?: unknown }): AgentGuest | null {
  pruneGuests()
  const focused = BrowserWindow.getFocusedWindow()
  const hostIds = [
    ...(focused && !focused.webContents.isDestroyed() ? [focused.webContents.id] : []),
    ...new Set(
      [...guests.keys()].map((key) => Number(key.split(":")[0])).filter((id) => id !== focused?.webContents.id),
    ),
  ]
  for (const hostId of hostIds) {
    const tabs = hostTabEntries(hostId)
    if (tabs.length === 0) continue
    const sessionID =
      typeof params.sessionID === "string" && isValidSessionID(params.sessionID) ? params.sessionID : undefined
    // Explicit tab wins (validated); then the session pin; then a tab no
    // other session pinned (OP-23: never hijack the viewed tab while a spare
    // exists — pins are in-memory, so after a restart the agent session owns
    // nothing and the old selected-first fallback painted over every view).
    const wanted =
      typeof params.tabId === "string" && isValidTabId(params.tabId)
        ? params.tabId
        : undefined
    const pinned = pinnedKey(sessionPins, sessionID, (key) => guests.has(key))
    const otherPinned = new Set<string>()
    for (const [owner, key] of sessionPins) {
      if (owner === sessionID) continue
      const prefix = `${hostId}:`
      if (key.startsWith(prefix)) otherPinned.add(key.slice(prefix.length))
    }
    const chosenId =
      tabs.find((tab) => tab.tabId === wanted)?.tabId ??
      (pinned === undefined ? undefined : tabs.find((tab) => tabKey(hostId, tab.tabId) === pinned)?.tabId) ??
      chooseAgentTabId({
        tabIds: tabs.map((tab) => tab.tabId),
        selectedTabId: selectedTab.get(hostId),
        otherPinnedTabIds: otherPinned,
      })
    const chosen = chosenId === undefined ? undefined : tabs.find((tab) => tab.tabId === chosenId)
    if (!chosen) continue
    if (sessionID) pinSession(sessionPins, sessionID, tabKey(hostId, chosen.tabId))
    if (sessionID && otherPinned.has(chosen.tabId))
      writeLog("browser", "agent borrowed a tab pinned to another session", { sessionID, tabId: chosen.tabId }, "warn")
    return {
      hostId,
      tabId: chosen.tabId,
      guest: chosen.guest,
      selected: chosen.tabId === selectedTab.get(hostId),
      sessionID,
    }
  }
  return null
}

export function readGuestState(guest: WebContents): BrowserState {
  return readState(guest)
}

export function readConsole(key: string, limit = 100): BrowserConsoleEntry[] {
  return (consoleLogs.get(key) ?? []).slice(-Math.max(1, Math.min(200, limit)))
}

export function clearConsole(key: string) {
  consoleLogs.set(key, [])
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
  const raw = (await guest
    .executeJavaScript(SNAPSHOT_SCRIPT, true)
    .catch((error: unknown) => {
      writeLog("browser", "snapshot script failed", { error: String(error).slice(0, 500) }, "warn")
      return null
    })) as {
    nodes?: { role: string; name: string; selector: string; label: string; depth: number }[]
    truncated?: boolean
  } | null
  const refs = new Map<number, string>()
  const nodes: BrowserSnapshotNode[] = (raw?.nodes ?? []).map((node, index) => {
    refs.set(index, node.selector)
    return { ref: index, role: node.role, name: node.name, selector: node.selector, depth: node.depth ?? 0 }
  })
  snapshotRefs.set(guest.id, refs)
  // A failed script run clears the signature so the next compare can never
  // report unchanged (mirrors VS Code _needsFullSnapshot after a miss).
  if (raw === null) snapshotSig.delete(guest.id)
  else snapshotSig.set(guest.id, signatureOf(nodes))
  return { url: guest.getURL(), title: guest.getTitle(), nodes, truncated: raw?.truncated ?? false }
}

// Snapshot right after an act: same list, plus unchanged:true when the page
// did not move since the previous snapshot for this guest. An explicit
// browser_snapshot always returns the full list (like VS Code read_page).
export async function takeActSnapshot(guest: WebContents): Promise<BrowserSnapshot & { unchanged: boolean }> {
  const previous = snapshotSig.get(guest.id)
  const snapshot = await takeSnapshot(guest)
  if (previous === undefined) return { ...snapshot, unchanged: false }
  return { ...snapshot, unchanged: previous === signatureOf(snapshot.nodes) }
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
  // Accepts a single expression (fast path, backwards compatible) and falls
  // back to a statement body so multi-statement agent scripts do not die
  // with "Unexpected token ';'". Expression `document.title` still returns
  // its value; statements run in order and return the explicit return value
  // (or undefined when there is none).
  const wrapped = `Promise.resolve().then(async () => {
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor
    try {
      return await new AsyncFn(${JSON.stringify(`return (${js})`)})()
    } catch (error) {
      if (error instanceof SyntaxError) return await new AsyncFn(${JSON.stringify(js)})()
      throw error
    }
  }).then(
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
  const image = await tryCapturePage(guest)
  if (!image || image.isEmpty()) return null
  const size = image.getSize()
  return {
    buffer: new Uint8Array(image.toPNG()).slice().buffer,
    width: size.width,
    height: size.height,
  }
}
