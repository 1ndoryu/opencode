// Pure Marketplace reply helper (no Electron imports so bun can test it).
// It never touches Facebook by itself: the caller feeds it the visible thread
// (listing title, last buyer message) plus the listing catalog from MN, and it
// returns reply drafts. Sending always stays human.

export type Aviso = {
  titulo: string
  precio: number
  operacion: string
}

export type Intencion = "precio" | "disponibilidad" | "visita" | "desconocida"

export type Borrador = {
  intencion: Intencion
  texto: string
}

export const CONTACTO = "Mayerlin Navarro 04249208855"

// Facebook listing titles don't always match the API titles.
// Aliases below are (facebook fragment -> api fragment), both normalized.
// "rio aro plaza" = "caroni plaza": confirmado por el usuario 2026-09-25.
const ALIAS_AVISO: Array<[string, string]> = [["rio aro plaza", "caroni plaza"]]

// Lowercase, no accents, single spaces: "Río  Aro-Plaza" -> "rio aro plaza".
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function aplicarAlias(titulo: string): string {
  return ALIAS_AVISO.reduce(
    (actual, par) => actual.replace(par[0], par[1]),
    titulo,
  )
}

const PATRON_PRECIO = /preci[ou]|cuanto|cuesta|val[eo]r|costo|\$\s?\d|negociable/
const PATRON_VISITA = /visita|ir a ver|verla|verlo|agendar|cita|cuando puedo|donde (queda|esta)/
const PATRON_DISPONIBILIDAD = /disponib|sigue|todavia|aun (esta|esta disponible)|queda/

// Detects the buyer intent from their last message. Price wins on ties
// ("Sigue disponible? Precio ??" is answered with the price first).
export function detectarIntencion(mensaje: string): Intencion {
  const texto = normalizar(mensaje)
  if (PATRON_PRECIO.test(texto)) return "precio"
  if (PATRON_VISITA.test(texto)) return "visita"
  if (PATRON_DISPONIBILIDAD.test(texto)) return "disponibilidad"
  return "desconocida"
}

function puntajeSolape(fb: string, aviso: string): number {
  const palabrasFb = new Set(fb.split(" ").filter((palabra) => palabra.length > 2))
  return aviso
    .split(" ")
    .filter((palabra) => palabra.length > 2)
    .filter((palabra) => palabrasFb.has(palabra)).length
}

// Matches a Facebook thread title against the catalog. Returns undefined when
// nothing matches: the caller then asks once and remembers per thread (F4).
export function emparejarAviso(tituloFb: string, catalogo: Aviso[]): Aviso | undefined {
  const fb = aplicarAlias(normalizar(tituloFb))
  const directo = catalogo.find((aviso) => {
    const titulo = normalizar(aviso.titulo)
    return fb.includes(titulo) || titulo.includes(fb)
  })
  if (directo) return directo
  const candidatos = catalogo
    .map((aviso) => ({ aviso, puntaje: puntajeSolape(fb, normalizar(aviso.titulo)) }))
    .filter((candidato) => candidato.puntaje >= 2)
    .sort((a, b) => b.puntaje - a.puntaje)
  return candidatos[0]?.aviso
}

// Venezuelan format: 43000 -> "43.000$".
export function formatearPrecio(precio: number): string {
  return `${Math.round(precio).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}$`
}

// Builds the drafts for the visible thread. Templates confirmed by the user
// 2026-09-25: "precio" needs the matched listing (price + contact, nothing
// else); "disponibilidad" and "visita" are generic and need no listing.
// Unknown intents return no draft: those grow from user corrections (F4).
export function generarBorradores(mensaje: string, tituloFb: string, catalogo: Aviso[]): Borrador[] {
  const intencion = detectarIntencion(mensaje)
  if (intencion === "precio") {
    const aviso = emparejarAviso(tituloFb, catalogo)
    if (!aviso) return []
    return [{ intencion, texto: `${formatearPrecio(aviso.precio)}\n${CONTACTO}` }]
  }
  if (intencion === "disponibilidad") return [{ intencion, texto: `Sí, sigue disponible. ${CONTACTO}` }]
  if (intencion === "visita")
    return [
      {
        intencion,
        texto: `Con gusto. Escríbeme al 04249208855 para coordinar la visita (o déjeme su número para contactarlo). ${CONTACTO}`,
      },
    ]
  return []
}
