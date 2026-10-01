// Pure PC-surface types and driver-output parsers for OP-36 (no Electron
// imports so bun can test this module; the driver itself lives in
// pc-service.ts). The driver schema is only loosely typed, so every field is
// defensively coerced here instead of at use sites.
//
// Everything on this surface is READ-ONLY on purpose: no click/type exists
// in F1, so a compromised prompt can at most read pixels, never act on them.
import { execFile } from "node:child_process"
import { nativeT } from "./native-translations"
export type PcBounds = {
  x: number
  y: number
  w: number
  h: number
}

export type PcWindow = {
  pid: number
  windowId: number
  processName: string
  title: string
  visible: boolean
  active: boolean
  bounds: PcBounds
}

export type PcElement = {
  index: number
  role: string
  label: string
  // Opaque driver handle (e.g. s00000002:15): the ONLY value click/type
  // accepts as element_token. The visible [index] is position, not identity.
  token: string
}

export type PcSnapshot = {
  pid: number
  windowId: number
  title: string
  captureId: string
  width: number
  height: number
  pngBase64: string
  elements: PcElement[]
}

export type PcDesktopShot = {
  captureId: string
  width: number
  height: number
  pngBase64: string
}

export type PcPermissions = {
  elevated: boolean
  integrityLevel: string
  uia: boolean
}

export function parseWindows(raw: unknown): PcWindow[] {
  if (!isRecord(raw) || !Array.isArray(raw.windows)) return []
  return raw.windows.filter(isRecord).map((entry) => {
    const bounds = isRecord(entry.bounds) ? entry.bounds : {}
    return {
      pid: num(entry.pid),
      windowId: num(entry.window_id),
      processName: str(entry.process_name),
      title: str(entry.title),
      visible: entry.visible !== false,
      active: entry.active === true,
      bounds: { x: num(bounds.x), y: num(bounds.y), w: num(bounds.w), h: num(bounds.h) },
    }
  })
}

export function parseElements(raw: unknown): PcElement[] {
  if (!isRecord(raw) || !Array.isArray(raw.elements)) return []
  return raw.elements.filter(isRecord).map((entry) => ({
    index: num(entry.element_index),
    role: str(entry.role),
    label: str(entry.label),
    token: str(entry.element_token),
  }))
}

export function parseDesktopShot(raw: unknown): PcDesktopShot {
  if (!isRecord(raw)) throw new Error(nativeT("desktop.pc.error.desktopNonObject"))
  const png = str(raw.screenshot_png_b64)
  if (!png) throw new Error(nativeT("desktop.pc.error.desktopNoImage"))
  return {
    captureId: str(raw.capture_id),
    width: num(raw.screenshot_width),
    height: num(raw.screenshot_height),
    pngBase64: png,
  }
}

export function parseSnapshot(raw: unknown, pid: number, windowId: number): PcSnapshot {
  if (!isRecord(raw)) throw new Error(nativeT("desktop.pc.error.windowNonObject"))
  const png = str(raw.screenshot_png_b64)
  if (!png) throw new Error(nativeT("desktop.pc.error.windowNoImage"))
  return {
    pid,
    windowId,
    title: str(raw.title),
    captureId: str(raw.capture_id),
    width: num(raw.screenshot_width),
    height: num(raw.screenshot_height),
    pngBase64: png,
    elements: parseElements(raw),
  }
}

export function parsePermissions(raw: unknown): PcPermissions {
  if (!isRecord(raw)) throw new Error(nativeT("desktop.pc.error.permissionNonObject"))
  return {
    elevated: raw.elevated === true,
    integrityLevel: str(raw.integrity_level) || "unknown",
    uia: raw.uia === true,
  }
}

// v1 allowlist for pc_open (OP-36 F2): only these packaged/desktop apps can
// be launched. Anything else — paths, URLs, extra arguments — is refused.
const OPEN_ALLOWLIST: Record<string, string> = {
  calculadora: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  calculator: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  notepad: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
  "bloc de notas": "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
}

export function allowedOpenAumids(): string[] {
  return [...new Set(Object.values(OPEN_ALLOWLIST))]
}

// Resolves a user-supplied open target to an allowlisted AUMID, or throws.
// v1 surface is deliberately narrow: named allowlist entries (mapped to
// AUMIDs) plus explicit allowlisted AUMIDs. Raw paths, launch_path, urls and
// additional_arguments are refused — they can point anywhere.
export type OpenTarget = { kind: "aumid"; aumid: string } | { kind: "name"; name: string }

// Resolves a user-supplied open target to an allowlisted launch, or throws.
// v1 surface is deliberately narrow: named allowlist entries (packaged apps
// resolve to AUMIDs, Explorer resolves by shell name) plus explicit
// allowlisted AUMIDs. Raw paths, launch_path, urls and additional_arguments
// are refused — they can point anywhere.
export function resolveOpenTarget(input: { aumid?: unknown; target?: unknown }): OpenTarget {
  if (typeof input.aumid === "string" && input.aumid.length > 0) {
    if (allowedOpenAumids().includes(input.aumid)) return { kind: "aumid", aumid: input.aumid }
    throw new Error(nativeT("desktop.pc.error.openRefusedAumid"))
  }
  if (typeof input.target === "string" && input.target.length > 0) {
    const key = input.target.trim().toLowerCase()
    if (key === "explorer" || key === "explorador" || key === "explorador de archivos") {
      // Explorer is not a packaged app: ShellExecuteEx resolves it by name
      // without stealing focus (driver launches hidden). Still gated here so
      // only this exact name passes.
      return { kind: "name", name: "Explorer" }
    }
    const aumid = OPEN_ALLOWLIST[key]
    if (aumid) return { kind: "aumid", aumid }
    throw new Error(nativeT("desktop.pc.error.openRefusedTarget", { target: input.target }))
  }
  throw new Error(nativeT("desktop.pc.error.openNeedsTarget"))
}

// Anti-own guard (OP-36 F2): the agent must never drive the app's own
// window. Matches on process pid (Electron main owns its top-level window)
// plus a name/title backstop in case the window lives in a child process.
export function isOwnWindow(
  entry: { pid: number; processName: string; title: string },
  self: { pid: number; names: string[] },
): boolean {
  if (entry.pid === self.pid) return true
  const haystack = `${entry.processName} ${entry.title}`.toLowerCase()
  // Dev-server backstop (plan: blocklist covers :4096/:4444/dev ports): a
  // window showing a localhost URL is a console/browser pointed at this
  // machine's own servers, never a legit automation target in v1.
  if (haystack.includes("localhost:") || haystack.includes("127.0.0.1")) return true
  return self.names.some((name) => name.length > 0 && haystack.includes(name.toLowerCase()))
}

// Maps validated tool params to the exact driver payload. Only whitelisted
// fields pass through: the driver rejects unknown fields
// (additionalProperties:false), so this is also the injection boundary.
export function buildActPayload(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const pid = params.pid
  const windowId = params.window_id
  const delivery = params.delivery_mode === "foreground" ? "foreground" : "background"
  const token = typeof params.element_token === "string" && params.element_token.length > 0 ? params.element_token : undefined
  if (tool === "scroll") {
    const direction = params.direction
    if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
      throw new Error(nativeT("desktop.pc.error.scrollDirection"))
    }
    const amount = params.amount
    return {
      target: { kind: "window", pid, window_id: windowId },
      direction,
      ...(params.by === "page" || params.by === "line" ? { by: params.by } : {}),
      ...(typeof amount === "number" && Number.isInteger(amount) && amount >= 1 && amount <= 50 ? { amount } : {}),
      delivery_mode: delivery,
    }
  }
  const payload: Record<string, unknown> = { pid, window_id: windowId, delivery_mode: delivery }
  if (token) payload.element_token = token
  if (tool === "click") {
    const x = params.x
    const y = params.y
    if (!token) {
      if (typeof x !== "number" || typeof y !== "number") {
        throw new Error(nativeT("desktop.pc.error.clickNeedsTarget"))
      }
      payload.x = x
      payload.y = y
    }
    if (params.button === "right" || params.button === "middle") payload.button = params.button
    if (params.count === 2 || params.count === 3) payload.count = params.count
    if (typeof params.capture_id === "string" && params.capture_id.length > 0) payload.capture_id = params.capture_id
    return payload
  }
  if (tool === "type_text") {
    if (typeof params.text !== "string" || params.text.length === 0) throw new Error(nativeT("desktop.pc.error.typeNeedsText"))
    payload.text = params.text
    if (typeof params.delay_ms === "number" && params.delay_ms >= 0 && params.delay_ms <= 200) {
      payload.delay_ms = Math.floor(params.delay_ms)
    }
    return payload
  }
  if (typeof params.key !== "string" || params.key.length === 0) throw new Error(nativeT("desktop.pc.error.keyNeedsKey"))
  payload.key = params.key
  if (Array.isArray(params.modifiers) && params.modifiers.every((mod) => typeof mod === "string")) {
    payload.modifiers = params.modifiers
  }
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// F2-3 hardening (OP-36 F3): this block lives here — not in pc-service.ts —
// because pc-service imports Electron and bun cannot load it in tests. All
// inputs are injected (env value, kill-file presence, timeout), so every
// item below is verifiable with real processes and zero mocks.
export const PC_CALL_TIMEOUT_MS = 30_000
const PC_MAX_BUFFER = 32 * 1024 * 1024

// Kill-switch: env OPENCODE_PC_DISABLED=1 (operator flips without rebuild)
// OR a `pc.kill` file in userData (flips without restart). Either refuses
// act/open in main even when the tool permission was granted. Removing the
// permission grant alone is NOT the kill-switch: under the OP-35 blanket
// `{"*":"allow"}` an ungranted computer still allows by wildcard (pinned by
// the revert-test in opencode) — the switch must live in main.
export const PC_KILL_ENV = "OPENCODE_PC_DISABLED"

export function isPcKillActive(envValue: string | undefined, killFilePresent: boolean): boolean {
  return envValue === "1" || killFilePresent
}

// Audit line: what (method/action), where (pid/window), when (ts), which
// session. Typed TEXT IS NEVER LOGGED (passwords would land on disk) —
// only the character count for type actions. The entry type has no text
// field by construction, so callers cannot leak it.
export type PcAuditEntry = {
  method: string
  pid?: number
  windowId?: number
  action: string
  chars?: number
  session: string
}

export function buildAuditLine(entry: PcAuditEntry): string {
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      method: entry.method,
      pid: entry.pid,
      windowId: entry.windowId,
      action: entry.action,
      chars: entry.chars,
      session: entry.session,
    }) + "\n"
  )
}

// Driver transport: JSON goes over stdin, never argv (PowerShell 5.1 strips
// quotes around field names in multi-field args, F0 lesson; argv has length
// caps). The call dies after timeoutMs so a hung driver cannot wedge the
// single-flight act queue forever.
export function runDriver(
  bin: string,
  args: string[],
  params: Record<string, unknown>,
  timeoutMs = PC_CALL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: PC_MAX_BUFFER }, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve(stdout)
    })
    child.stdin?.write(JSON.stringify(params))
    child.stdin?.end()
  })
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}
