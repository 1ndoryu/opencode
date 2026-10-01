import { write as writeLog } from "./logging"
import { sharedDriver } from "./pc-service"
import { resolveOpenTarget } from "./pc-format"
import { nativeT } from "./native-translations"

export type PcBridgeRequest = {
  type: "pc-request"
  id: string
  method: string
  params?: Record<string, unknown>
}

export type PcBridgeResponse = {
  type: "pc-response"
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

let sender: ((message: PcBridgeResponse) => void) | undefined

export function attachPcBridge(send: (message: PcBridgeResponse) => void) {
  sender = send
}

export function detachPcBridge() {
  sender = undefined
}

export function isPcBridgeMessage(value: unknown): value is PcBridgeRequest {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<PcBridgeRequest>
  return message.type === "pc-request" && typeof message.id === "string" && typeof message.method === "string"
}

export async function routePcBridgeMessage(message: PcBridgeRequest) {
  try {
    sender?.({ type: "pc-response", id: message.id, ok: true, result: await dispatch(message) })
  } catch (error) {
    writeLog("pc", "bridge request failed", { method: message.method }, "warn")
    sender?.({
      type: "pc-response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function dispatch(message: PcBridgeRequest): Promise<unknown> {
  const driver = sharedDriver()
  const params = message.params ?? {}
  switch (message.method) {
    case "screenshot":
      return driver.desktop()
    case "windows":
      return driver.windows()
    case "snapshot": {
      const pid = params.pid
      const windowId = params.window_id
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        throw new Error(nativeT("desktop.pc.error.snapshotNeedsPid"))
      }
      if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) {
        throw new Error(nativeT("desktop.pc.error.snapshotNeedsWindow"))
      }
      return driver.snapshot(pid, windowId)
    }
    case "permissions": {
      const perms = await driver.permissions()
      if (!perms.elevated) {
        writeLog("pc", "daemon not elevated: admin windows will read empty and background input is dropped by UIPI", undefined, "warn")
      }
      return perms
    }
    case "act": {
      const action = params.action
      if (action !== "click" && action !== "type" && action !== "key" && action !== "scroll") {
        throw new Error(nativeT("desktop.pc.error.actNeedsAction"))
      }
      // pid/window_id validated again in main: the tool never reaches the
      // driver except through this gate (anti-own + allowlist live here).
      return driver.act({ ...params, action })
    }
    case "open": {
      // Allowlist enforced in main, not in the tool: a compromised prompt
      // cannot bypass it by calling the bridge differently.
      if (typeof params.path === "string" || typeof params.launch_path === "string" || params.urls !== undefined || params.additional_arguments !== undefined) {
        throw new Error(nativeT("desktop.pc.error.openRawRefused"))
      }
      return driver.open(resolveOpenTarget({ aumid: params.aumid, target: params.target }))
    }
    default:
      throw new Error(nativeT("desktop.pc.error.unknownMethod", { method: message.method }))
  }
}
