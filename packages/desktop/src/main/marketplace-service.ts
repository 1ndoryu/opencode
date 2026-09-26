import { ipcMain } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { allMarketplaceGuests, marketplaceGuests, readMarketplaceThreads } from "./browser-service"
import { generarBorradores, type Aviso, type Borrador } from "./marketplace-assistant"
import {
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_TTL_MS,
  apiCatalogUrl,
  catalogFromApi,
} from "./marketplace-catalog"
import {
  floatDraftsFor,
  floatInvokeScript,
  parseFloatSync,
  type MpFloatStrings,
} from "./marketplace-float"
import { nativeT } from "./native-translations"

// OP-33 F2: catalog cache + drafts IPC for the manual Marketplace assistant
// strip. Main never touches Facebook: it only fetches the MN listing catalog
// (loopback or https) and runs the pure draft engine. Sending always stays
// human; F2 has no guest-DOM access at all.
// OP-33 F3: marketplace-poll adds a bounded guest read (title + visible text
// tail, Marketplace URLs only, no network to Meta) so the strip can badge
// threads with news. Still read-only: no clicks, no fills, no navigation.
// OP-33 F3c: floating prototype sync. Runs inside marketplace-poll (the same
// manual refresh the strip already uses, nothing automatic): installs the
// float program in each Marketplace guest, reads its window list + pending
// Generar request, answers it with drafts from the pure engine + catalog, and
// pushes them back into the page. Read-only against Facebook: no clicks,
// no fills, no navigation; the only write is our own shadow-DOM panel.
async function syncMarketplaceFloat(
  event: IpcMainInvokeEvent,
  args: { strings?: { go?: unknown; copied?: unknown }; catalogo?: unknown },
): Promise<void> {
  console.log("[mp-float] poll recibido")
  let guests: ReturnType<typeof marketplaceGuests> = []
  try {
    guests = marketplaceGuests(event)
  } catch (error) {
    console.log(`[mp-float] error guests: ${String(error).slice(0, 160)}`)
    return
  }
  if (guests.length === 0) {
    console.log("[mp-float] sin pestañas marketplace en esta ventana")
    return
  }
  const strings: MpFloatStrings = {
    go: typeof args?.strings?.go === "string" && args.strings.go ? args.strings.go : "Generar",
    copied:
      typeof args?.strings?.copied === "string" && args.strings.copied ? args.strings.copied : "¡Copiado!",
  }
  const catalogo = Array.isArray(args?.catalogo) ? catalogFromApi(args.catalogo) : (catalogCache?.avisos ?? [])
  let windows = 0
  let answered = 0
  let headers = 0
  let composers = 0
  const pageErrors: string[] = []
  for (const { guest } of guests) {
    const raw = await guest.executeJavaScript(floatInvokeScript(strings), true).catch(() => null)
    const sync = parseFloatSync(raw)
    if (!sync) continue
    windows += sync.windows.length
    headers += sync.stats.headers
    composers += sync.stats.composers
    if (sync.error) pageErrors.push(sync.error)
    const want = sync.want
    if (!want) continue
    const drafts = floatDraftsFor(generarBorradores(want.excerpt, want.listing, catalogo))
    const pushed = await guest
      .executeJavaScript(
        `window.__mpPushDrafts(${JSON.stringify(want.key)}, ${JSON.stringify(drafts)})`,
        true,
      )
      .catch(() => false)
    if (pushed === true) answered += 1
  }
  console.log(`\n>>> [mp-float] guests=${guests.length} ventanas=${windows} generados=${answered} headers=${headers} composers=${composers} <<<\n`)
  for (const pageError of pageErrors) console.log(`[mp-float] error pagina: ${pageError}`)
}

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

// OP-33 F3d: automatic float loop, strip-independent. Every FLOAT_AUTO_MS the
// main process sweeps every attached Marketplace guest: the injected program
// installs itself (first sweep) and reports its windows + pending Generar
// request, which main answers with drafts from the pure engine + catalog.
// Nothing is ever sent to Facebook and no model tokens are spent (the draft
// engine is local templates); the only network is the MN catalog fetch, which
// reuses the TTL cache. The loop is silent unless windows appear/disappear or
// a Generar is answered.
const FLOAT_AUTO_MS = 5000
const DEFAULT_CATALOG_URL = "https://mn-inmobiliaria.com"
const DEFAULT_FLOAT_STRINGS: MpFloatStrings = { go: "Generar", copied: "¡Copiado!" }

// One-shot anchor probe per guest: when no header matches, dump the page's
// aria-labels (truncated, local console only) so the selectors can be
// recalibrated against the real markup without any user effort.
const ANCHOR_PROBE_SCRIPT = `Array.from(document.querySelectorAll("div[aria-label]"), function (el) { return (el.getAttribute("aria-label") || "").slice(0, 80) }).slice(0, 40)`

let floatLoopStarted = false
let lastAutoWindows = -1
const floatProbedGuests = new Set<number>()

async function probeFloatAnchors(guest: WebContents): Promise<void> {
  if (floatProbedGuests.has(guest.id)) return
  floatProbedGuests.add(guest.id)
  const labels = await guest.executeJavaScript(ANCHOR_PROBE_SCRIPT, true).catch(() => null)
  if (!Array.isArray(labels)) return
  console.log(`[mp-float] anclas=${labels.length} ${JSON.stringify(labels.slice(0, 12))}`)
}

async function autoSyncMarketplaceFloat(): Promise<void> {
  const guests = allMarketplaceGuests()
  if (guests.length === 0) {
    lastAutoWindows = 0
    return
  }
  const catalog = await loadCatalog(DEFAULT_CATALOG_URL, false).catch(() => null)
  const catalogo = catalog && !catalog.error ? catalog.avisos : (catalogCache?.avisos ?? [])
  let windows = 0
  let answered = 0
  for (const { guest } of guests) {
    const raw = await guest.executeJavaScript(floatInvokeScript(DEFAULT_FLOAT_STRINGS), true).catch(() => null)
    const sync = parseFloatSync(raw)
    if (!sync) continue
    windows += sync.windows.length
    if (sync.stats.headers === 0) await probeFloatAnchors(guest)
    const want = sync.want
    if (!want) continue
    const drafts = floatDraftsFor(generarBorradores(want.excerpt, want.listing, catalogo))
    const pushed = await guest
      .executeJavaScript(
        `window.__mpPushDrafts(${JSON.stringify(want.key)}, ${JSON.stringify(drafts)})`,
        true,
      )
      .catch(() => false)
    if (pushed === true) answered += 1
  }
  if (windows !== lastAutoWindows || answered > 0) {
    console.log(`[mp-float] auto guests=${guests.length} ventanas=${windows} generados=${answered}`)
    lastAutoWindows = windows
  }
}

function startMarketplaceFloatLoop(): void {
  if (floatLoopStarted) return
  floatLoopStarted = true
  setInterval(() => {
    void autoSyncMarketplaceFloat().catch(() => undefined)
  }, FLOAT_AUTO_MS)
}

export function registerMarketplaceIpcHandlers() {
  startMarketplaceFloatLoop()
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
  ipcMain.handle(
    "marketplace-poll",
    async (event: IpcMainInvokeEvent, args?: { strings?: { go?: unknown; copied?: unknown }; catalogo?: unknown }) => {
      console.log("[mp-poll] refresh recibido")
      const threads = await readMarketplaceThreads(event).catch((error: unknown) => {
        console.log(`[mp-poll] error hilos: ${String(error).slice(0, 160)}`)
        return []
      })
      await syncMarketplaceFloat(event, args ?? {}).catch(() => undefined)
      return threads
    },
  )
}
