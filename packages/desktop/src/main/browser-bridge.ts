import { BrowserWindow } from "electron"
import { write as writeLog } from "./logging"
import { resolveAgentURL } from "./browser-policy"
import { isValidSessionID, NoAgentTabError, tabKey } from "./browser-tabs"
import {
  actOnRef,
  captureFull,
  clearConsole,
  controlGuest,
  evaluateInGuest,
  hasAttachedTabs,
  navigateGuest,
  readConsole,
  readGuestState,
  resolveAgentGuest,
  takeActSnapshot,
  takeSnapshot,
  type AgentGuest,
} from "./browser-service"

export type BrowserBridgeRequest = {
  type: "browser-request"
  id: string
  method: string
  params?: Record<string, unknown>
}

export type BrowserBridgeResponse = {
  type: "browser-response"
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

const SCREENSHOT_LIMIT = 6 * 1024 * 1024

const NOT_ATTACHED =
  "Browser is not attached — open the Navegador tab in the Desktop app sidebar first, then retry. " +
  "Browser tools only work in Desktop (not in CLI/TUI)."

let sender: ((message: BrowserBridgeResponse) => void) | undefined

export function attachBrowserBridge(send: (message: BrowserBridgeResponse) => void) {
  sender = send
}

export function detachBrowserBridge() {
  sender = undefined
}

export function isBrowserBridgeMessage(value: unknown): value is BrowserBridgeRequest {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<BrowserBridgeRequest>
  return message.type === "browser-request" && typeof message.id === "string" && typeof message.method === "string"
}

export async function routeBrowserBridgeMessage(message: BrowserBridgeRequest) {
  try {
    sender?.({ type: "browser-response", id: message.id, ok: true, result: await dispatch(message) })
  } catch (error) {
    writeLog("browser", "bridge request failed", { method: message.method }, "warn")
    sender?.({
      type: "browser-response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function dispatch(message: BrowserBridgeRequest): Promise<unknown> {
  const params: Record<string, unknown> = message.params ?? {}
  switch (message.method) {
    case "state": {
      const active = requireAgentGuest(params, false)
      if (!active) return { attached: false }
      return { attached: true, tabId: active.tabId, ...readGuestState(active.guest) }
    }
    case "navigate": {
      const active = requireAgentGuest(params, true)
      if (typeof params.url !== "string") throw new Error("navigate needs a url string")
      if (!resolveAgentURL(params.url)) throw new Error("navigate refused: private LAN/link-local URLs are blocked for the agent (localhost dev preview is allowed)")
      return { attached: true, tabId: active.tabId, ...(await navigateGuest(active.guest, params.url)) }
    }
    case "control": {
      const active = requireAgentGuest(params, true)
      if (params.action !== "back" && params.action !== "forward" && params.action !== "reload" && params.action !== "stop") {
        throw new Error("control needs action back|forward|reload|stop")
      }
      return { attached: true, tabId: active.tabId, ...controlGuest(active.guest, params.action) }
    }
    case "console": {
      const active = requireAgentGuest(params, true)
      const limit = typeof params.limit === "number" ? params.limit : 100
      const key = tabKey(active.hostId, active.tabId)
      const entries = readConsole(key, limit)
      if (params.clear === true) clearConsole(key)
      return { attached: true, tabId: active.tabId, entries }
    }
    case "snapshot": {
      const active = requireAgentGuest(params, true)
      return { attached: true, tabId: active.tabId, ...(await takeSnapshot(active.guest)) }
    }
    case "act": {
      const active = requireAgentGuest(params, true)
      if (typeof params.ref !== "number") throw new Error("act needs a numeric ref from a snapshot")
      if (params.action !== "click" && params.action !== "fill" && params.action !== "focus" && params.action !== "hover" && params.action !== "scroll") {
        throw new Error("act needs action click|fill|focus|hover|scroll")
      }
      const acted = await actOnRef(
        active.guest,
        params.ref,
        params.action,
        typeof params.text === "string" ? params.text : undefined,
      )
      return { attached: true, tabId: active.tabId, ...acted, snapshot: await takeActSnapshot(active.guest) }
    }
    case "evaluate": {
      const active = requireAgentGuest(params, true)
      if (typeof params.js !== "string") throw new Error("evaluate needs a js string")
      return { attached: true, tabId: active.tabId, result: await evaluateInGuest(active.guest, params.js) }
    }
    case "screenshot": {
      const active = requireAgentGuest(params, true)
      const capture = await captureFull(active.guest)
      if (!capture)
        throw new Error(
          "Browser screenshot unavailable (no display surface) — bring the Desktop window front, open the Navegador tab, unminimize, ensure the page is visible, then retry",
        )
      if (capture.buffer.byteLength > SCREENSHOT_LIMIT) throw new Error("Browser screenshot too large")
      return {
        attached: true,
        tabId: active.tabId,
        width: capture.width,
        height: capture.height,
        dataUrl: `data:image/png;base64,${Buffer.from(capture.buffer).toString("base64")}`,
      }
    }
    default:
      throw new Error(`Unknown browser method ${message.method}`)
  }
}

// Resolves the agent's guest (explicit tab > session pin > unpinned spare)
// and, when the agent touched a background tab, flips the panel to it so
// the user sees what the agent is doing. Returns null only for fail-closed
// "state". Required calls throw NOT_ATTACHED when no page is attached, or
// NO_AGENT_TAB when pages exist but all belong to other conversations.
function requireAgentGuest(params: Record<string, unknown>, required: true): AgentGuest
function requireAgentGuest(params: Record<string, unknown>, required: false): AgentGuest | null
function requireAgentGuest(params: Record<string, unknown>, required: boolean): AgentGuest | null {
  const active = resolveAgentGuest(params)
  if (!active) {
    if (!required) return null
    if (!hasAttachedTabs()) throw new Error(NOT_ATTACHED)
    throw new NoAgentTabError(isValidSessionID(params.sessionID) ? params.sessionID : undefined)
  }
  if (!active.selected) {
    const win = BrowserWindow.fromId(active.hostId)
    // OP-23: the renderer files the tab under the acting session (never the
    // viewed one) and only flips to it when that session is on screen, so
    // carry which session acted.
    if (win && !win.isDestroyed())
      win.webContents.send("browser-select-tab", { tabId: active.tabId, sessionID: active.sessionID })
  }
  return active
}
