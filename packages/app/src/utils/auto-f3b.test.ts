import { describe, expect, test } from "bun:test"
import { AutoBudget } from "./auto-budget"
import { AutoSummaryRing } from "./auto-summary"
import { buildSteer, isSteerFresh, isSteerTokenValid, issueSteerToken } from "./auto-steer"

describe("AutoBudget atomic reserve", () => {
  test("reserves up to the cap then fails closed", () => {
    const budget = new AutoBudget({ maxTurns: 3, maxTokens: 1000, maxMs: 60_000 })
    expect(budget.reserve({ turns: 1, tokens: 400 })).toEqual({ ok: true })
    expect(budget.reserve({ turns: 1, tokens: 400 })).toEqual({ ok: true })
    const third = budget.reserve({ turns: 1, tokens: 400 })
    expect(third).toEqual({ ok: false, reason: "tokens" })
    expect(budget.snapshot().tokensUsed).toBe(800)
  })
  test("turn cap binds before token cap", () => {
    const budget = new AutoBudget({ maxTurns: 1, maxTokens: 1_000_000, maxMs: 60_000 })
    expect(budget.reserve({ turns: 1, tokens: 10 })).toEqual({ ok: true })
    expect(budget.reserve({ turns: 1, tokens: 10 })).toEqual({ ok: false, reason: "turns" })
  })
  test("warns at 80 percent", () => {
    const budget = new AutoBudget({ maxTurns: 10, maxTokens: 1000, maxMs: 60_000 })
    budget.reserve({ turns: 8, tokens: 100 })
    expect(budget.snapshot().warn80).toBe(true)
    expect(budget.snapshot().exhausted).toBe(false)
  })
  test("close stops further reserves and yields resumable text", () => {
    const budget = new AutoBudget({ maxTurns: 30, maxTokens: 120_000, maxMs: 1_200_000 })
    budget.reserve({ turns: 4, tokens: 9000 })
    const closing = budget.close("blocked-no-advance")
    expect(closing.summary).toContain("4 turns")
    expect(closing.resumeHint.length).toBeGreaterThan(0)
    expect(budget.reserve({ turns: 1, tokens: 1 })).toEqual({ ok: false, reason: "closed" })
  })
})

describe("steer grammar", () => {
  test("accepts a well-formed continue steer", () => {
    const steer = buildSteer({ goal: "continue", hintRef: ["goal-tests", "goal-docs"] }, "turn-1")
    expect(steer?.goal).toBe("continue")
    expect(steer?.turnId).toBe("turn-1")
    expect(steer && isSteerFresh(steer, "turn-1")).toBe(true)
  })
  test("rejects unknown goal and bad hint ids", () => {
    expect(buildSteer({ goal: "proceed", hintRef: [] }, "t")).toBeNull()
    expect(buildSteer({ goal: "stop", hintRef: ["UPPER CASE"] }, "t")).toBeNull()
    expect(buildSteer({ goal: "stop", hintRef: "`rm -rf`" }, "t")).toBeNull()
  })
  test("fuzz: hostile inputs never produce a steer", () => {
    const hostile = [
      { goal: "continue; DROP TABLE", hintRef: [] },
      { goal: ["continue"], hintRef: [] },
      { goal: "stop", hintRef: "goal-tests" },
      { goal: "stop", hintRef: ["/etc/passwd"] },
      { goal: "stop", hintRef: ["a".repeat(65)] },
    ]
    for (const input of hostile) expect(buildSteer(input, "t")).toBeNull()
  })
  test("steer is bound to its turn and expiry", () => {
    const steer = buildSteer({ goal: "summarize", hintRef: [] }, "turn-9")
    expect(steer && isSteerFresh(steer, "turn-8")).toBe(false)
    expect(steer && isSteerFresh(steer, "turn-9", steer.exp + 1)).toBe(false)
  })
})

describe("steer token", () => {
  const secret = "test-secret"
  test("round-trips for the same turn", () => {
    const token = issueSteerToken("turn-2", secret)
    expect(isSteerTokenValid(token, "turn-2", secret)).toBe(true)
  })
  test("rejects wrong turn, tampering and expiry", () => {
    const token = issueSteerToken("turn-2", secret)
    expect(isSteerTokenValid(token, "turn-3", secret)).toBe(false)
    expect(isSteerTokenValid(`${token}x`, "turn-2", secret)).toBe(false)
    expect(isSteerTokenValid(token, "turn-2", "other-secret")).toBe(false)
    const [turn, exp, mac] = token.split(".")
    const expiredAt = Number(exp) + 61_000
    expect(isSteerTokenValid(`${turn}.${exp}.${mac}`, "turn-2", secret, expiredAt)).toBe(false)
  })
})

describe("summary ring", () => {
  test("caps at fifty and evicts oldest", () => {
    const ring = new AutoSummaryRing()
    for (let i = 0; i < 55; i++) ring.push("s1", "progress", `detail ${i}`)
    expect(ring.size).toBe(50)
    expect(ring.forSession("s1")[0].detail).toBe("detail 5")
  })
  test("clears per session without touching others", () => {
    const ring = new AutoSummaryRing()
    ring.push("s1", "progress", "a")
    ring.push("s2", "complete", "b")
    ring.clearSession("s1")
    expect(ring.forSession("s1")).toEqual([])
    expect(ring.forSession("s2")).toHaveLength(1)
  })
})
