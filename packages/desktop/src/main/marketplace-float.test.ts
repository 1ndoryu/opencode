import { describe, expect, test } from "bun:test"
import {
  FLOAT_HEADER_PREFIXES,
  FLOAT_SCRIPT,
  FLOAT_VERSION,
  excerptFor,
  floatDraftsFor,
  floatInvokeScript,
  floatKeyFor,
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
    const script = floatInvokeScript({ go: "Generar", copied: "¡Copiado!" })
    expect(script.startsWith("(function(s){")).toBe(true)
    expect(script).toContain('"go":"Generar"')
  })
})

describe("parseFloatSync", () => {
  const window = { key: "k", buyer: "Aracelis", listing: "Casa", price: "VEF0", excerpt: "Hola" }
  test("acepta el estado con pedido pendiente", () => {
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [window], want: window })).toEqual({
      v: FLOAT_VERSION,
      windows: [window],
      want: window,
    })
  })
  test("acepta el estado sin pedido", () => {
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: null })?.want).toBeNull()
  })
  test("rechaza versiones, ventanas y pedidos malformados", () => {
    expect(parseFloatSync(null)).toBeNull()
    expect(parseFloatSync({ v: 999, windows: [], want: null })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [{ key: 1 }], want: null })).toBeNull()
    expect(parseFloatSync({ v: FLOAT_VERSION, windows: [], want: { key: 1 } })).toBeNull()
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
