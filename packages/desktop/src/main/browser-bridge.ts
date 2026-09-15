import { write as writeLog } from "./logging"
import { resolveAgentURL } from "./browser-policy"
import {
  actOnRef,
  captureFull,
  clearConsole,
  controlGuest,
  evaluateInGuest,
  getActiveGuest,
  navigateGuest,
  readConsole,
  readGuestState,
  takeSnapshot,
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
      const active = getActiveGuest()
      if (!active) return { attached: false }
      return { attached: true, ...readGuestState(active.guest) }
    }
    case "navigate": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      if (typeof params.url !== "string") throw new Error("navigate needs a url string")
      if (!resolveAgentURL(params.url)) throw new Error("navigate refused: agent navigation to local/private URLs is blocked")
      return { attached: true, ...(await navigateGuest(active.guest, params.url)) }
    }
    case "control": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      if (params.action !== "back" && params.action !== "forward" && params.action !== "reload" && params.action !== "stop") {
        throw new Error("control needs action back|forward|reload|stop")
      }
      return { attached: true, ...controlGuest(active.guest, params.action) }
    }
    case "console": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      const limit = typeof params.limit === "number" ? params.limit : 100
      const entries = readConsole(active.hostId, limit)
      if (params.clear === true) clearConsole(active.hostId)
      return { attached: true, entries }
    }
    case "snapshot": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      return { attached: true, ...(await takeSnapshot(active.guest)) }
    }
    case "act": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
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
      return { attached: true, ...acted, snapshot: await takeSnapshot(active.guest) }
    }
    case "evaluate": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      if (typeof params.js !== "string") throw new Error("evaluate needs a js string")
      return { attached: true, result: await evaluateInGuest(active.guest, params.js) }
    }
    case "screenshot": {
      const active = getActiveGuest()
      if (!active) throw new Error(NOT_ATTACHED)
      const capture = await captureFull(active.guest)
      if (!capture) throw new Error("Browser screenshot came back empty")
      if (capture.buffer.byteLength > SCREENSHOT_LIMIT) throw new Error("Browser screenshot too large")
      return {
        attached: true,
        width: capture.width,
        height: capture.height,
        dataUrl: `data:image/png;base64,${Buffer.from(capture.buffer).toString("base64")}`,
      }
    }
    default:
      throw new Error(`Unknown browser method ${message.method}`)
  }
}
