// Pure PC-surface types and driver-output parsers for OP-36 (no Electron
// imports so bun can test this module; the driver itself lives in
// pc-service.ts). The driver schema is only loosely typed, so every field is
// defensively coerced here instead of at use sites.
//
// Everything on this surface is READ-ONLY on purpose: no click/type exists
// in F1, so a compromised prompt can at most read pixels, never act on them.
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
  }))
}

export function parseDesktopShot(raw: unknown): PcDesktopShot {
  if (!isRecord(raw)) throw new Error("PC desktop capture returned non-object")
  const png = str(raw.screenshot_png_b64)
  if (!png) throw new Error("PC desktop capture returned no image")
  return {
    captureId: str(raw.capture_id),
    width: num(raw.screenshot_width),
    height: num(raw.screenshot_height),
    pngBase64: png,
  }
}

export function parseSnapshot(raw: unknown, pid: number, windowId: number): PcSnapshot {
  if (!isRecord(raw)) throw new Error("PC window capture returned non-object")
  const png = str(raw.screenshot_png_b64)
  if (!png) throw new Error("PC window capture returned no image")
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
  if (!isRecord(raw)) throw new Error("PC permission query returned non-object")
  return {
    elevated: raw.elevated === true,
    integrityLevel: str(raw.integrity_level) || "unknown",
    uia: raw.uia === true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}
