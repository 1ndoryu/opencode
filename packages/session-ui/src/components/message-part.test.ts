import { describe, expect, test } from "bun:test"
import { readPartText, splitEstadoLine } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("splitEstadoLine", () => {
  test("returns text untouched when there is no ESTADO line", () => {
    expect(splitEstadoLine("Paso 4 completado: app.js.")).toEqual({ body: "Paso 4 completado: app.js." })
  })

  test("splits a trailing SIGUE line with detail", () => {
    expect(splitEstadoLine("Paso 4 completado: app.js.\nESTADO: SIGUE: Implementar formulario")).toEqual({
      body: "Paso 4 completado: app.js.",
      estado: { state: "SIGUE", detail: "Implementar formulario" },
    })
  })

  test("splits COMPLETO without detail", () => {
    expect(splitEstadoLine("Todo hecho.\nESTADO: COMPLETO")).toEqual({
      body: "Todo hecho.",
      estado: { state: "COMPLETO", detail: undefined },
    })
  })

  test("splits BLOQUEADO keeping the blocker as detail", () => {
    expect(splitEstadoLine("No puedo seguir.\nESTADO: BLOQUEADO: falta la API key")).toEqual({
      body: "No puedo seguir.",
      estado: { state: "BLOQUEADO", detail: "falta la API key" },
    })
  })

  test("ignores unknown states", () => {
    expect(splitEstadoLine("Texto.\nESTADO: PENDIENTE: algo").estado).toBeUndefined()
  })
})
