import { ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { generarBorradores, type Aviso, type Borrador } from "./marketplace-assistant"
import {
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_TTL_MS,
  apiCatalogUrl,
  catalogFromApi,
} from "./marketplace-catalog"
import { nativeT } from "./native-translations"

// OP-33 F2: catalog cache + drafts IPC for the manual Marketplace assistant
// strip. Main never touches Facebook: it only fetches the MN listing catalog
// (loopback or https) and runs the pure draft engine. Sending always stays
// human; F2 has no guest-DOM access at all.

type CatalogCache = { apiUrl: string; avisos: Aviso[]; fetchedAt: number }

let catalogCache: CatalogCache | undefined

export type CatalogResult = { avisos: Aviso[]; fetchedAt: number; fromCache: boolean; error?: string }

async function loadCatalog(apiUrl: string, refresh: boolean): Promise<CatalogResult> {
  const fresh =
    !refresh && catalogCache?.apiUrl === apiUrl.trim() && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS
      ? catalogCache
      : undefined
  if (fresh) return { avisos: fresh.avisos, fetchedAt: fresh.fetchedAt, fromCache: true }
  const stale = catalogCache?.apiUrl === apiUrl.trim() ? catalogCache : undefined
  const fallback = (error: string): CatalogResult => ({
    avisos: stale?.avisos ?? [],
    fetchedAt: stale?.fetchedAt ?? 0,
    fromCache: true,
    error,
  })
  const url = apiCatalogUrl(apiUrl)
  if (!url) return fallback(nativeT("desktop.browser.assistant.catalog.invalidUrl"))
  const response = await fetch(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) }).catch(() => null)
  if (!response || !response.ok) return fallback(nativeT("desktop.browser.assistant.catalog.unreachable"))
  const avisos = catalogFromApi(await response.json().catch(() => null))
  catalogCache = { apiUrl: apiUrl.trim(), avisos, fetchedAt: Date.now() }
  return { avisos, fetchedAt: catalogCache.fetchedAt, fromCache: false }
}

export function registerMarketplaceIpcHandlers() {
  ipcMain.handle("marketplace-catalog", (_event: IpcMainInvokeEvent, opts: { apiUrl?: unknown; refresh?: unknown }) => {
    const apiUrl = typeof opts?.apiUrl === "string" ? opts.apiUrl : ""
    return loadCatalog(apiUrl, opts?.refresh === true)
  })
  ipcMain.handle(
    "marketplace-drafts",
    (_event: IpcMainInvokeEvent, input: { mensaje?: unknown; tituloFb?: unknown; catalogo?: unknown }) => {
      const mensaje = typeof input?.mensaje === "string" ? input.mensaje : ""
      const tituloFb = typeof input?.tituloFb === "string" ? input.tituloFb : ""
      const catalogo = Array.isArray(input?.catalogo)
        ? catalogFromApi(input.catalogo)
        : (catalogCache?.avisos ?? [])
      return generarBorradores(mensaje, tituloFb, catalogo) as Borrador[]
    },
  )
}
