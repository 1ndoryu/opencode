import { describe, expect, test } from "bun:test"
import {
  TELEFONO,
  WHATSAPP,
  detectarIntencion,
  emparejarAviso,
  formatearPrecio,
  generarBorradores,
  normalizar,
  saludoPorHora,
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

describe("saludoPorHora", () => {
  test("sigue la hora de Venezuela (formato 2026-09-27 confirmado por la usuaria)", () => {
    expect(saludoPorHora(new Date("2026-09-27T09:30:00-04:00"))).toBe("buenos días")
    expect(saludoPorHora(new Date("2026-09-27T16:00:00-04:00"))).toBe("buenas tardes")
    expect(saludoPorHora(new Date("2026-09-27T22:00:00-04:00"))).toBe("buenas noches")
  })
  test("fronteras 05 / 12 / 19", () => {
    expect(saludoPorHora(new Date("2026-09-27T04:59:00-04:00"))).toBe("buenas noches")
    expect(saludoPorHora(new Date("2026-09-27T05:00:00-04:00"))).toBe("buenos días")
    expect(saludoPorHora(new Date("2026-09-27T11:59:00-04:00"))).toBe("buenos días")
    expect(saludoPorHora(new Date("2026-09-27T12:00:00-04:00"))).toBe("buenas tardes")
    expect(saludoPorHora(new Date("2026-09-27T18:59:00-04:00"))).toBe("buenas tardes")
    expect(saludoPorHora(new Date("2026-09-27T19:00:00-04:00"))).toBe("buenas noches")
  })
})

describe("generarBorradores", () => {
  const TARDE = new Date("2026-09-27T16:00:00-04:00")
  const DIA = new Date("2026-09-27T09:30:00-04:00")
  const BLOQUE = `📞 Contacto\n${TELEFONO}\n${WHATSAPP}`
  test("pregunta de precio: saludo + valor + bloque de contacto separado", () => {
    expect(generarBorradores("Precio por favor", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo, TARDE)).toEqual([
      { intencion: "precio", texto: `Hola, buenas tardes. El inmueble tiene un valor de 50.000$ negociable.\n\n${BLOQUE}` },
    ])
  })
  test("precio con alias de aviso y saludo de mañana", () => {
    expect(generarBorradores("Precio ??", "Apartamento Residencias Rio Aro Plaza Puerto Ordaz", catalogo, DIA)).toEqual([
      { intencion: "precio", texto: `Hola, buenos días. El inmueble tiene un valor de 43.000$ negociable.\n\n${BLOQUE}` },
    ])
  })
  test("regateo con aviso: precio negociable con saludo", () => {
    expect(
      generarBorradores("¿Acepta 40.000?", "Apartamento Residencias Rio Aro Plaza Puerto Ordaz", catalogo, TARDE),
    ).toEqual([
      { intencion: "negociacion", texto: `Hola, buenas tardes. Sí, el valor es de 43.000$ negociable.\n\n${BLOQUE}` },
    ])
  })
  test("regateo sin aviso: sin borrador (precio siempre o nada)", () => {
    expect(generarBorradores("¿Me rebaja algo?", "Título que no existe", catalogo, TARDE)).toEqual([])
  })
  test("disponibilidad con aviso: saludo + sigue disponible + precio", () => {
    expect(generarBorradores("Hola. Sigue disponible?", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo, TARDE)).toEqual(
      [{ intencion: "disponibilidad", texto: `Hola, buenas tardes. Sí, sigue disponible. El inmueble tiene un valor de 50.000$ negociable.\n\n${BLOQUE}` }],
    )
  })
  test("mensaje típico de apertura: saludo + disponible + precio negociable", () => {
    expect(
      generarBorradores(
        "Hola, Mayerlin. ¿Sigue disponible?",
        "Apartamento Residencias Rio Aro Plaza Puerto Ordaz",
        catalogo,
        TARDE,
      ),
    ).toEqual([{ intencion: "disponibilidad", texto: `Hola, buenas tardes. Sí, sigue disponible. El inmueble tiene un valor de 43.000$ negociable.\n\n${BLOQUE}` }])
  })
  test("disponibilidad sin aviso: sin borrador (precio siempre o nada)", () => {
    expect(generarBorradores("Hola. Sigue disponible?", "Título que no existe", catalogo, TARDE)).toEqual([])
  })
  test("visita: saludo + plantilla confirmada + bloque (no necesita aviso)", () => {
    expect(generarBorradores("Puedo ir a verla mañana?", "Casa en venta en Riberas del Caroní, Puerto Ordaz", catalogo, TARDE)).toEqual(
      [
        {
          intencion: "visita",
          texto: `Hola, buenas tardes. Con gusto. Escríbeme al ${TELEFONO} para coordinar la visita (o déjeme su número para contactarlo).\n\n${BLOQUE}`,
        },
      ],
    )
  })
  test("aviso desconocido: sin borrador aunque pidan precio", () => {
    expect(generarBorradores("Precio", "2 habitaciones 2 baños Departamento/condominio", catalogo, TARDE)).toEqual([])
  })
  test("intención desconocida con aviso: disponibilidad con precio (abre desde la lista)", () => {
    expect(generarBorradores("Hola, me interesa", "Apartamento semi amoblado en venta", catalogo, TARDE)).toEqual([
      { intencion: "desconocida", texto: `Hola, buenas tardes. Sí, sigue disponible. El inmueble tiene un valor de 35.000$ negociable.\n\n${BLOQUE}` },
    ])
  })
  test("intención desconocida sin aviso: sin borrador", () => {
    expect(generarBorradores("Buenas noches", "Título que no existe", catalogo, TARDE)).toEqual([])
  })
})
