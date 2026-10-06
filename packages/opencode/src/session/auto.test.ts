import { describe, expect, test } from "bun:test"
import { SessionAuto } from "./auto"

const msgs = (...m: SessionAuto.ExitMessage[]) => m
const user = (id: string, text: string): SessionAuto.ExitMessage => ({
  info: { role: "user", id },
  parts: [{ type: "text", text }],
})
const steer = (id: string, n: number): SessionAuto.ExitMessage => ({
  info: { role: "user", id },
  parts: [{ type: "text", text: `[Auto ${n}/30] sigue`, synthetic: true, metadata: { auto: "steer" } }],
})
const assistant = (id: string, text: string, tool = false): SessionAuto.ExitMessage => ({
  info: { role: "assistant", id },
  parts: tool ? [{ type: "tool", tool: "bash" }, { type: "text", text }] : [{ type: "text", text }],
})

describe("steersSinceUser", () => {
  test("counts auto steers and resets on real user input", () => {
    expect(SessionAuto.steersSinceUser(msgs(user("m1", "hola"), steer("m2", 1), steer("m3", 2)))).toBe(2)
    expect(
      SessionAuto.steersSinceUser(msgs(user("m1", "hola"), steer("m2", 1), user("m3", "sigue tú"))),
    ).toBe(0)
  })
})

describe("evaluateExit", () => {
  test("auto OFF stops like today", () => {
    expect(SessionAuto.evaluateExit({ enabled: false, messages: msgs(user("m1", "hola")) })).toEqual({
      action: "stop",
      n: 0,
    })
  })

  test("two turns without ESTADO continue", () => {
    const history = msgs(
      user("m1", "arregla el bug"),
      steer("m2", 1),
      assistant("a1", "miro el código"),
      steer("m3", 2),
      assistant("a2", "sigo mirando"),
    )
    expect(SessionAuto.evaluateExit({ enabled: true, messages: history })).toEqual({
      action: "continue",
      n: 2,
    })
  })

  test("COMPLETO and BLOQUEADO stop with motivo", () => {
    expect(
      SessionAuto.evaluateExit({
        enabled: true,
        messages: msgs(user("m1", "haz X"), assistant("a1", "listo\nESTADO: COMPLETO")),
      }),
    ).toEqual({ action: "stop", n: 0 })
    expect(
      SessionAuto.evaluateExit({
        enabled: true,
        messages: msgs(user("m1", "haz X"), assistant("a1", "no puedo\nESTADO: BLOQUEADO: falta token")),
      }),
    ).toEqual({ action: "stop", motivo: "falta token", n: 0 })
  })

  test("error in the last assistant message stops", () => {
    const failed: SessionAuto.ExitMessage = {
      info: { role: "assistant", id: "a1", error: { message: "boom" } },
      parts: [{ type: "text", text: "fallé" }],
    }
    expect(SessionAuto.evaluateExit({ enabled: true, messages: msgs(user("m1", "haz X"), failed) })).toEqual({
      action: "stop",
      motivo: "error del asistente",
      n: 0,
    })
  })

  test("steer cap stops at 30", () => {
    const history: SessionAuto.ExitMessage[] = [user("m1", "haz X")]
    for (let n = 1; n <= 30; n++) {
      history.push(steer(`s${n}`, n), assistant(`a${n}`, `paso ${n} distinto`))
    }
    expect(SessionAuto.evaluateExit({ enabled: true, messages: history })).toEqual({
      action: "stop",
      motivo: "límite 30 intentos",
      n: 30,
    })
  })

  test("three auto turns without tool calls stop", () => {
    const history = msgs(
      user("m1", "haz X"),
      steer("m2", 1),
      assistant("a1", "texto uno"),
      steer("m3", 2),
      assistant("a2", "texto dos"),
      steer("m4", 3),
      assistant("a3", "texto tres"),
    )
    expect(SessionAuto.evaluateExit({ enabled: true, messages: history })).toEqual({
      action: "stop",
      motivo: "sin avance",
      n: 3,
    })
  })

  test("tool calls with distinct text keep going", () => {
    const history = msgs(
      user("m1", "haz X"),
      steer("m2", 1),
      assistant("a1", "reviso", true),
      steer("m3", 2),
      assistant("a2", "aplico", true),
      steer("m4", 3),
      assistant("a3", "verifico", true),
    )
    expect(SessionAuto.evaluateExit({ enabled: true, messages: history })).toEqual({
      action: "continue",
      n: 3,
    })
  })
})

describe("parseDecision", () => {
  test("parses continuar and terminar with instruction", () => {
    expect(SessionAuto.parseDecision("ORDEN: continuar\nINSTRUCCION: revisa el diff")).toEqual({
      order: "continuar",
      instruction: "revisa el diff",
    })
    expect(SessionAuto.parseDecision("ORDEN: terminar\nINSTRUCCION: tarea completa")).toEqual({
      order: "terminar",
      instruction: "tarea completa",
    })
  })

  test("rejects garbage, ask-user and missing instruction", () => {
    expect(SessionAuto.parseDecision("sigo trabajando")).toBeUndefined()
    expect(SessionAuto.parseDecision("ORDEN: ask-user\nINSTRUCCION: pregunto")).toBeUndefined()
    expect(SessionAuto.parseDecision("ORDEN: continuar")).toBeUndefined()
    expect(SessionAuto.parseDecision("ORDEN: continuar\nINSTRUCCION:   ")).toBeUndefined()
  })

  test("trims instruction to 280 chars", () => {
    const long = "x".repeat(300)
    expect(SessionAuto.parseDecision(`ORDEN: continuar\nINSTRUCCION: ${long}`)?.instruction).toHaveLength(280)
  })
})

describe("stepAfterDecide", () => {
  test("steer and stop reset the fail counter", () => {
    expect(
      SessionAuto.stepAfterDecide({ fails: 1, n: 2, goal: "X", result: { kind: "steer", text: "[Auto 2/30] sigue" } }),
    ).toEqual({ action: "continue", text: "[Auto 2/30] sigue", fails: 0 })
    expect(
      SessionAuto.stepAfterDecide({ fails: 1, n: 2, result: { kind: "stop", motivo: "tarea completa" } }),
    ).toEqual({ action: "stop", motivo: "tarea completa", fails: 0 })
  })

  test("first fallback keeps the fixed nudge, second fallback stops", () => {
    const first = SessionAuto.stepAfterDecide({ fails: 0, n: 1, goal: "X", result: { kind: "fallback" } })
    expect(first.action).toBe("continue")
    if (first.action === "continue") {
      expect(first.text).toContain("[Auto 1/30]")
      expect(first.fails).toBe(1)
    }
    expect(SessionAuto.stepAfterDecide({ fails: 1, n: 2, result: { kind: "fallback" } })).toEqual({
      action: "stop",
      motivo: "decider sin respuesta",
      fails: 2,
    })
  })
})

describe("deciderSnapshot", () => {
  test("carries goal and last turns, ignoring steers", () => {
    const snapshot = SessionAuto.deciderSnapshot({
      goal: "arreglar el bug",
      messages: msgs(
        user("m1", "arregla el bug"),
        steer("m2", 1),
        assistant("a1", "miro el código"),
        assistant("a2", "sigo mirando"),
      ),
    })
    expect(snapshot).toContain("Objetivo: arreglar el bug")
    expect(snapshot).toContain("arregla el bug")
    expect(snapshot).toContain("miro el código")
    expect(snapshot).toContain("sigo mirando")
    expect(snapshot).not.toContain("[Auto 1/30]")
  })
})
