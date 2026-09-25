import type { Aviso } from "./marketplace-assistant"

// Pure catalog parsing (no Electron imports so bun can test it).
// GET /api/public/inmuebles answers {items,total,page,per_page}; a bare array
// is accepted too so tests and future endpoints stay compatible.

export const CATALOG_TTL_MS = 5 * 60 * 1000
export const CATALOG_FETCH_TIMEOUT_MS = 15_000
export const CATALOG_MAX_ITEMS = 500

export function catalogFromApi(payload: unknown): Aviso[] {
  const items = Array.isArray(payload) ? payload : (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return []
  return items.slice(0, CATALOG_MAX_ITEMS).flatMap(catalogEntry)
}

function catalogEntry(item: unknown): Aviso[] {
  const record = (item ?? {}) as Record<string, unknown>
  const titulo = typeof record["titulo"] === "string" ? record["titulo"].trim() : ""
  const precio = Number(record["precio"])
  if (titulo === "" || !Number.isFinite(precio)) return []
  const operacion =
    typeof record["operacion"] === "string" && record["operacion"] !== "" ? record["operacion"] : "venta"
  return [{ titulo, precio, operacion }]
}

export function apiCatalogUrl(apiUrl: string): string | undefined {
  const base = apiUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(base)) return undefined
  return `${base}/api/public/inmuebles`
}
