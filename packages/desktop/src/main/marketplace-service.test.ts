import { describe, expect, test } from "bun:test"
import { apiCatalogUrl, catalogFromApi } from "./marketplace-catalog"

describe("catalogFromApi", () => {
  test("acepta la forma {items} de GET /api/public/inmuebles", () => {
    const avisos = catalogFromApi({
      items: [{ titulo: "Casa Riberas del Caroní", precio: 43000, operacion: "venta" }],
      total: 1,
      page: 1,
      per_page: 50,
    })
    expect(avisos).toEqual([{ titulo: "Casa Riberas del Caroní", precio: 43000, operacion: "venta" }])
  })

  test("acepta un array directo", () => {
    expect(catalogFromApi([{ titulo: "A", precio: 10 }])).toEqual([{ titulo: "A", precio: 10, operacion: "venta" }])
  })

  test("filtra entradas sin titulo o sin precio numerico", () => {
    const avisos = catalogFromApi({
      items: [
        { titulo: "Ok", precio: 5 },
        { titulo: "", precio: 5 },
        { titulo: "Sin precio" },
        { titulo: "NaN", precio: "mucho" },
        null,
      ],
    })
    expect(avisos).toEqual([{ titulo: "Ok", precio: 5, operacion: "venta" }])
  })

  test("payload no objeto devuelve vacio", () => {
    expect(catalogFromApi(null)).toEqual([])
    expect(catalogFromApi("texto")).toEqual([])
    expect(catalogFromApi({ total: 0 })).toEqual([])
  })
})

describe("apiCatalogUrl", () => {
  test("solo http(s), sin barras finales", () => {
    expect(apiCatalogUrl("https://mn-inmobiliaria.com/")).toBe("https://mn-inmobiliaria.com/api/public/inmuebles")
    expect(apiCatalogUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/api/public/inmuebles")
    expect(apiCatalogUrl("ftp://x.com")).toBeUndefined()
    expect(apiCatalogUrl("mn-inmobiliaria.com")).toBeUndefined()
  })
})
