import { describe, expect, test } from "bun:test"
import {
  CONTACTO,
  detectarIntencion,
  emparejarAviso,
  formatearPrecio,
  generarBorradores,
  normalizar,
  type Aviso,
} from "./marketplace-assistant"

const catalogo: Aviso[] = [
  { titulo: "Apartamento Residencias Caroní Plaza", precio: 43000, operacion: "venta" },
  { titulo: "Casa en venta en Riberas del Caroní", precio: 50000, operacion: "venta" },
  { titulo: "Townhouse 2 niveles en Arivana", precio: 1500, operacion: "alquiler" },
  { titulo: "Apartamento semi amoblado en venta en Alta vista", precio: 35000, operacion: "venta" },
  { titulo: "Casa en venta en Urbanización Villa Icabarú", precio: 90000, operacion: "venta" },
]

describe("normalizar", () => {
  test("quita acentos, minúsculas y ruido", () => {
    expect(normalizar("Río  Aro-Plaza, Puerto Ordaz")).toBe("rio aro plaza puerto ordaz")
  })
})

describe("detectarIntencion", () => {
  test("precio directo y con signos", () => {
    expect(detectarIntencion("Precio ??")).toBe("precio")
    expect(detectarIntencion("35.000$ negociable?")).toBe("precio")
    expect(detectarIntencion("Cuánto cuesta")).toBe("precio")
  })
  test("disponibilidad", () => {
    expect(detectarIntencion("Hola. ¿Sigue estando disponible?")).toBe("disponibilidad")
    expect(detectarIntencion("Hola. Sigue disponible?")).toBe("disponibilidad")
  })
  test("negociación", () => {
    expect(detectarIntencion("¿Acepta 40.000?")).toBe("negociacion")
    expect(detectarIntencion("¿Cuál es el último precio?")).toBe("negociacion")
    expect(detectarIntencion("Me rebaja algo?")).toBe("negociacion")
  })
  test("negociación gana a precio en el mismo mensaje", () => {
    expect(detectarIntencion("¿Acepta ese precio?")).toBe("negociacion")
  })
  test("responde al último turno, no al historial", () => {
    expect(detectarIntencion(`Precio ??\n${"x".repeat(500)}\nQuiero ir a verla`)).toBe("visita")
    expect(detectarIntencion(`Quiero ir a verla\n${"x".repeat(500)}\nPrecio por favor`)).toBe("precio")
  })
  test("visita", () => {
    expect(detectarIntencion("Quiero ir a verla")).toBe("visita")
    expect(detectarIntencion("Coordinamos una visita?")).toBe("visita")
  })
  test("saludo sin pregunta queda desconocida", () => {
    expect(detectarIntencion("Buenas noches")).toBe("desconocida")
  })
})

describe("emparejarAviso", () => {
  test("alias Rio Aro Plaza = Caroní Plaza (usuario 2026-09-25)", () => {
    expect(emparejarAviso("Apartamento Residencias Rio Aro Plaza Puerto Ordaz", catalogo)?.precio).toBe(43000)
  })
  test("título con ciudad al final", () => {
    expect(emparejarAviso("Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo)?.precio).toBe(50000)
    expect(emparejarAviso("Alquiler Townhouse 2 niveles en Arivana, Puerto Ordaz.", catalogo)?.precio).toBe(1500)
  })
  test("insensible a mayúsculas y acentos", () => {
    expect(emparejarAviso("APARTAMENTO SEMI AMOBLADO EN VENTA EN ALTA VISTA", catalogo)?.precio).toBe(35000)
  })
  test("aviso desconocido devuelve undefined (lo resuelve la memoria F4)", () => {
    expect(emparejarAviso("2 habitaciones 2 baños Departamento/condominio", catalogo)).toBeUndefined()
  })
})

describe("formatearPrecio", () => {
  test("formato venezolano con $", () => {
    expect(formatearPrecio(43000)).toBe("43.000$")
    expect(formatearPrecio(1500)).toBe("1.500$")
  })
})

describe("generarBorradores", () => {
  test("pregunta de precio: solo precio negociable + contacto", () => {
    expect(generarBorradores("Precio por favor", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo)).toEqual([
      { intencion: "precio", texto: `50.000$ negociable\n${CONTACTO}` },
    ])
  })
  test("precio con alias de aviso", () => {
    expect(generarBorradores("Precio ??", "Apartamento Residencias Rio Aro Plaza Puerto Ordaz", catalogo)).toEqual([
      { intencion: "precio", texto: `43.000$ negociable\n${CONTACTO}` },
    ])
  })
  test("regateo con aviso: precio negociable", () => {
    expect(
      generarBorradores("¿Acepta 40.000?", "Apartamento Residencias Rio Aro Plaza Puerto Ordaz", catalogo),
    ).toEqual([{ intencion: "negociacion", texto: `Sí, 43.000$ negociable. ${CONTACTO}` }])
  })
  test("regateo sin aviso: sin borrador (precio siempre o nada)", () => {
    expect(generarBorradores("¿Me rebaja algo?", "Título que no existe", catalogo)).toEqual([])
  })
  test("disponibilidad con aviso: lleva el precio negociable", () => {
    expect(generarBorradores("Hola. Sigue disponible?", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo)).toEqual(
      [{ intencion: "disponibilidad", texto: `Sí, sigue disponible. 50.000$ negociable. ${CONTACTO}` }],
    )
  })
  test("mensaje típico de apertura: saludo + disponible + precio negociable", () => {
    expect(
      generarBorradores(
        "Hola, Mayerlin. ¿Sigue disponible?",
        "Apartamento Residencias Rio Aro Plaza Puerto Ordaz",
        catalogo,
      ),
    ).toEqual([{ intencion: "disponibilidad", texto: `Sí, sigue disponible. 43.000$ negociable. ${CONTACTO}` }])
  })
  test("disponibilidad sin aviso: sin borrador (precio siempre o nada)", () => {
    expect(generarBorradores("Hola. Sigue disponible?", "Título que no existe", catalogo)).toEqual([])
  })
  test("visita: plantilla confirmada (no necesita aviso)", () => {
    expect(generarBorradores("Puedo ir a verla mañana?", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo)).toEqual(
      [
        {
          intencion: "visita",
          texto: `Con gusto. Escríbeme al 04249208855 para coordinar la visita (o déjeme su número para contactarlo). ${CONTACTO}`,
        },
      ],
    )
  })
  test("aviso desconocido: sin borrador aunque pidan precio", () => {
    expect(generarBorradores("Precio", "2 habitaciones 2 baños Departamento/condominio", catalogo)).toEqual([])
  })
  test("intención desconocida: sin borrador (precio siempre o nada)", () => {
    expect(generarBorradores("Hola, me interesa", "Apartamento semi amoblado en venta", catalogo)).toEqual([])
    expect(generarBorradores("Buenas noches", "Apartamento semi amoblado en venta", catalogo)).toEqual([])
  })
})
