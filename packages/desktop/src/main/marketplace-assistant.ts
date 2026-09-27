// Pure Marketplace reply helper (no Electron imports so bun can test it).
// It never touches Facebook by itself: the caller feeds it the visible thread
// (listing title, last buyer message) plus the listing catalog from MN, and it
// returns reply drafts. Sending always stays human.

export type Aviso = {
  titulo: string
  precio: number
  operacion: string
}

export type Intencion = "precio" | "disponibilidad" | "visita" | "negociacion" | "desconocida"

export type Borrador = {
  intencion: Intencion
  texto: string
}

export const TELEFONO = "04249208855"
export const WHATSAPP = "wa.me/584249208855"

// Greeting follows Venezuela time (America/Caracas), where the listings are:
// 05:00-11:59 días, 12:00-18:59 tardes, rest noches.
export function saludoPorHora(ahora: Date = new Date()): string {
  const parte = new Intl.DateTimeFormat("es-VE", {
    timeZone: "America/Caracas",
    hour: "numeric",
    hour12: false,
  }).format(ahora)
  const hora = Number(parte) % 24
  if (hora >= 5 && hora < 12) return "buenos días"
  if (hora >= 12 && hora < 19) return "buenas tardes"
  return "buenas noches"
}

// Contact block the user confirmed 2026-09-27 (simplified): header,
// phone and direct wa.me link, each on its own line after a blank line.
function conContacto(cuerpo: string): string {
  return `${cuerpo}\n\n📞 Contacto\n${TELEFONO}\n${WHATSAPP}`
}

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

const PATRON_NEGOCIACION = /acepta|rebaja|descuent|minimo|ultimo precio|oferta|regate|dejas en|cierras en|mejoras el precio/
const PATRON_PRECIO = /preci[ou]|cuanto|cuesta|val[eo]r|costo|\$\s?\d|negociable/
const PATRON_VISITA = /visita|ir a ver|verla|verlo|agendar|cita|cuando puedo|donde (queda|esta)/
const PATRON_DISPONIBILIDAD = /disponib|sigue|todavia|aun (esta|esta disponible)|queda/

// Detects the buyer intent from the latest turn (last ~300 chars of the
// visible tail: the tail mixes both sides, so only the end reflects where the
// conversation stands). Negotiation wins over plain price ("¿Cuál es el último
// precio?" is haggling, not a first price ask); price still wins over the rest.
export function detectarIntencion(mensaje: string): Intencion {
  const texto = normalizar(mensaje.slice(-300))
  if (PATRON_NEGOCIACION.test(texto)) return "negociacion"
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
// 2026-09-25 (+ negociable always on prices, 2026-09-25→26; precio siempre o
// nada, 2026-09-26 con "visita" como única excepción sin precio): "precio",
// "negociacion" y "disponibilidad" solo devuelven borrador con precio del
// aviso emparejado (sin aviso = sin borrador, el panel muestra las opciones
// vacías + la línea de depuración en vez de un genérico sin número);
// "desconocida" con aviso emparejado devuelve disponibilidad con precio:
// al abrir el chat desde la lista la cola a veces solo trae el encabezado
// (sin mensajes aún) y la intención no se detecta, pero el precio del aviso
// sí se conoce (caso Janeth/Villa Tocoma 2026-09-26). Sin aviso = vacío.
// Format confirmed 2026-09-27 (simplified): greeting by Venezuela hour +
// body + contact block (header, phone, wa.me) each on its own line.
export function generarBorradores(mensaje: string, tituloFb: string, catalogo: Aviso[], ahora: Date = new Date()): Borrador[] {
  const intencion = detectarIntencion(mensaje)
  const saludo = saludoPorHora(ahora)
  if (intencion === "precio") {
    const aviso = emparejarAviso(tituloFb, catalogo)
    if (!aviso) return []
    return [
      {
        intencion,
        texto: conContacto(`Hola, ${saludo}. El inmueble tiene un valor de ${formatearPrecio(aviso.precio)} negociable.`),
      },
    ]
  }
  if (intencion === "negociacion") {
    const aviso = emparejarAviso(tituloFb, catalogo)
    if (!aviso) return []
    return [
      {
        intencion,
        texto: conContacto(`Hola, ${saludo}. Sí, el valor es de ${formatearPrecio(aviso.precio)} negociable.`),
      },
    ]
  }
  if (intencion === "disponibilidad") {
    const aviso = emparejarAviso(tituloFb, catalogo)
    if (!aviso) return []
    return [
      {
        intencion,
        texto: conContacto(
          `Hola, ${saludo}. Sí, sigue disponible. El inmueble tiene un valor de ${formatearPrecio(aviso.precio)} negociable.`,
        ),
      },
    ]
  }
  if (intencion === "visita")
    return [
      {
        intencion,
        texto: conContacto(
          `Hola, ${saludo}. Con gusto. Escríbeme al ${TELEFONO} para coordinar la visita (o déjeme su número para contactarlo).`,
        ),
      },
    ]
  if (intencion === "desconocida") {
    const aviso = emparejarAviso(tituloFb, catalogo)
    if (!aviso) return []
    return [
      {
        intencion,
        texto: conContacto(
          `Hola, ${saludo}. Sí, sigue disponible. El inmueble tiene un valor de ${formatearPrecio(aviso.precio)} negociable.`,
        ),
      },
    ]
  }
  return []
}
