import { describe, expect, test } from "bun:test"
import {
  FLOAT_HEADER_PREFIXES,
  FLOAT_SCRIPT,
  FLOAT_VERSION,
  buildFloatDebug,
  draftsConPrecio,
  excerptFor,
  excerptSigFor,
  floatCacheAction,
  floatDraftsFor,
  floatInvokeScript,
  floatKeyFor,
  mantenerPrecioCacheado,
  parseFloatHeader,
  parseFloatSync,
} from "./marketplace-float"

describe("parseFloatHeader", () => {
  test("extrae comprador y aviso del aria-label en español", () => {
    expect(parseFloatHeader("Conversación con el título Aracelis · Casa en venta en Riberas del Caroní, Puerto Ordaz")).toEqual({
      buyer: "Aracelis",
      listing: "Casa en venta en Riberas del Caroní, Puerto Ordaz",
    })
  })
  test("acepta el prefijo en inglés", () => {
    expect(parseFloatHeader("Conversation titled Edgar · Casa Riberas del Caroní")).toEqual({
      buyer: "Edgar",
      listing: "Casa Riberas del Caroní",
    })
  })
  test("sin separador deja el aviso vacío", () => {
    expect(parseFloatHeader("Conversación con el título Jose")).toEqual({ buyer: "Jose", listing: "" })
  })
  test("rechaza aria-labels que no son de conversación", () => {
    expect(parseFloatHeader("Ver comprador")).toBeUndefined()
    expect(parseFloatHeader("")).toBeUndefined()
    expect(parseFloatHeader("Conversación con el título ")).toBeUndefined()
  })
  test("los prefijos cubren español e inglés", () => {
    expect(FLOAT_HEADER_PREFIXES).toContain("Conversación con el título ")
    expect(FLOAT_HEADER_PREFIXES).toContain("Conversation titled ")
  })
})

describe("floatKeyFor", () => {
  test("normaliza y acota a 120", () => {
    expect(floatKeyFor("Aracelis", "Casa  en   venta")).toBe("aracelis|casa en venta")
    expect(floatKeyFor("A".repeat(200), "B".repeat(200)).length).toBe(120)
  })
})

describe("excerptFor", () => {
  test("devuelve la cola para detectar la intención", () => {
    expect(excerptFor("x".repeat(2000)).length).toBe(1200)
    expect(excerptFor("¿Sigue disponible?")).toBe("¿Sigue disponible?")
  })
})

describe("FLOAT_SCRIPT", () => {
  test("es JavaScript sintácticamente válido", () => {
    expect(() => new Function("s", FLOAT_SCRIPT)).not.toThrow()
  })
  test("el invocador envuelve con los strings localizados", () => {
    const script = floatInvokeScript({ regenerate: "Regenerar", copied: "¡Copiado!" })
    expect(script.startsWith("(function(s){")).toBe(true)
    expect(script).toContain('"regenerate":"Regenerar"')
  })
  test("el push evita repintar el mismo texto con distinta firma", () => {
    expect(FLOAT_SCRIPT).toContain("renderedText")
  })
  test("el panel lleva línea de depuración visible", () => {
    expect(FLOAT_SCRIPT).toContain("mp-d")
    expect(FLOAT_SCRIPT).toContain("renderedDebug")
  })
  test("la raíz prefiere el ancestro con composer y texto (chats desde la lista)", () => {
    expect(FLOAT_SCRIPT).toContain('contenteditable')
    expect(FLOAT_SCRIPT).toContain("dimFallback")
  })
})

describe("parseFloatSync", () => {
  const window = { key: "k", buyer: "Aracelis", listing: "Casa", price: "VEF0", excerpt: "Hola", force: false }
  const stats = { headers: 1, composers: 1 }
  test("acepta el estado con pedido pendiente", () => {
    const want = { ...window, force: true }
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [window], want, focusedKey: null, stats })).toEqual({
      v: FLOAT_VERSION,
      windows: [window],
      want,
      focusedKey: null,
      stats,
    })
  })
  test("acepta el estado sin pedido", () => {
    expect(
      parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null, stats: { headers: 0, composers: 0 } })?.want,
    ).toBeNull()
  })
  test("propaga la ventana con foco para el auto-copiado", () => {
    expect(
      parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null, focusedKey: "k", stats })?.focusedKey,
    ).toBe("k")
  })
  test("rechaza versiones, ventanas, stats y pedidos malformados", () => {
    expect(parseFloatSync(null)).toBeNull()
    expect(parseFloatSync({ v: 999, windows: [], want: null, stats })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [{ ...window, force: "no" }], want: null, stats })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: { key: 1 }, stats })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null, stats: { headers: "1", composers: 1 } })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null, focusedKey: 7, stats })).toBeNull()
  })
  test("el scan reporta el foco para no mezclar 2 chats", () => {
    expect(FLOAT_SCRIPT).toContain("focusedKey")
    expect(FLOAT_SCRIPT).toContain("activeElement")
  })
})

describe("excerptSigFor", () => {
  test("estable para el mismo mensaje y distinta ante avance", () => {
    expect(excerptSigFor("Hola, Mayerlin. ¿Sigue disponible?")).toBe(excerptSigFor("Hola, Mayerlin. ¿Sigue disponible?"))
    expect(excerptSigFor("Hola, Mayerlin. ¿Sigue disponible?")).not.toBe(excerptSigFor("Hola, Mayerlin. ¿Sigue disponible? ¿Acepta 40.000?"))
  })
})

describe("floatCacheAction", () => {
  test("el mismo mensaje reutiliza, el avance o Regenerar generan", () => {
    expect(floatCacheAction("ab12", "ab12", false)).toBe("reuse")
    expect(floatCacheAction("ab12", "cd34", false)).toBe("generate")
    expect(floatCacheAction(undefined, "cd34", false)).toBe("generate")
    expect(floatCacheAction("ab12", "ab12", true)).toBe("generate")
  })
})

describe("draftsConPrecio", () => {
  test("detecta el $ de las plantillas con precio", () => {
    expect(draftsConPrecio([{ text: "35.000$ negociable" }])).toBe(true)
    expect(draftsConPrecio([{ text: "Sí, sigue disponible. Mayerlin Navarro" }])).toBe(false)
    expect(draftsConPrecio([])).toBe(false)
  })
})

describe("buildFloatDebug", () => {
  test("resume intención, aviso y cola en una línea", () => {
    const debug = buildFloatDebug({
      intencion: "disponibilidad",
      listing: "Casa en venta en Riberas del Caroní",
      avisoTitulo: "Casa en venta en Riberas del Caroní",
      avisoPrecio: "50.000$",
      total: 11,
      excerpt: "Hola, Mayerlin. ¿Sigue disponible?",
    })
    expect(debug).toContain("d=disponibilidad")
    expect(debug).toContain("50.000$")
    expect(debug).toContain("cat=11")
  })
  test("sin aviso queda explícito", () => {
    const debug = buildFloatDebug({
      intencion: "desconocida",
      listing: "Título raro",
      total: 11,
      excerpt: "Hola",
    })
    expect(debug).toContain("sin aviso")
  })
})

describe("mantenerPrecioCacheado", () => {
  const conPrecio = [{ id: "disponibilidad", text: "Sí, sigue disponible. 35.000$ negociable. Mayerlin Navarro 04249208855" }]
  const generica = [{ id: "desconocida", text: "Sí, sigue disponible. Mayerlin Navarro 04249208855" }]
  test("la genérica desconocida no pisa borradores con precio", () => {
    expect(mantenerPrecioCacheado({ sig: "a", drafts: conPrecio }, generica, "desconocida")).toBe(true)
  })
  test("sin caché, sin precio en caché o con intención real no mantiene", () => {
    expect(mantenerPrecioCacheado(undefined, generica, "desconocida")).toBe(false)
    expect(mantenerPrecioCacheado({ sig: "a", drafts: generica }, generica, "desconocida")).toBe(false)
    expect(mantenerPrecioCacheado({ sig: "a", drafts: conPrecio }, conPrecio, "disponibilidad")).toBe(false)
    expect(mantenerPrecioCacheado({ sig: "a", drafts: conPrecio }, generica, "visita")).toBe(false)
  })
})

describe("floatDraftsFor", () => {
  test("mapea a id/text y acota a 3 opciones", () => {
    const drafts = floatDraftsFor([
      { intencion: "precio", texto: "a" },
      { intencion: "disponibilidad", texto: "b" },
      { intencion: "visita", texto: "c" },
      { intencion: "desconocida", texto: "d" },
    ])
    expect(drafts).toEqual([
      { id: "precio", text: "a" },
      { id: "disponibilidad", text: "b" },
      { id: "visita", text: "c" },
    ])
  })
})
