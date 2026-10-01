import { write as writeLog } from "./logging"
import { sharedDriver } from "./pc-service"

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

export const PC_NOT_ATTACHED_MESSAGE =
  "PC is not attached — PC tools only work in the Desktop app (not in CLI/TUI), " +
  "and only on the machine running it. Retry from a Desktop session."

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
        throw new Error("pc snapshot needs an integer pid (see pc_windows output)")
      }
      if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) {
        throw new Error("pc snapshot needs an integer window_id (see pc_windows output)")
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
    default:
      throw new Error(`Unknown PC method: ${message.method}`)
  }
}
