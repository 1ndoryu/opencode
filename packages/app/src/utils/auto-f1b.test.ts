import { describe, expect, test } from "bun:test"
import { AutoBudget } from "./auto-budget"
import { AutoTaskRegistry } from "./auto-session"
import { renderPanelVerdict } from "./auto-verdict"

function budget() {
  return new AutoBudget({ maxTurns: 30, maxTokens: 120_000, maxMs: 1_200_000 })
}

describe("ephemeral orderer session", () => {
  test("start tracks main and order sessions separately", () => {
    const registry = new AutoTaskRegistry()
    const snap = registry.start("main-1", "order-1", budget())
    expect(snap.mainSessionID).toBe("main-1")
    expect(snap.orderSessionID).toBe("order-1")
    expect(snap.machineState).toBe("IDLE")
    expect(registry.get("main-1")?.orderSessionID).toBe("order-1")
  })
  test("stop wipes the orderer side and yields resumable text", () => {
    const registry = new AutoTaskRegistry()
    registry.start("main-1", "order-1", budget())
    registry.ring("main-1")?.push("order-1", "progress", "working on tests")
    const text = registry.stop("main-1", "user-stop")
    expect(text).toContain("user-stop")
    expect(text).toContain("Resume with the same goal")
    expect(registry.get("main-1")).toBeNull()
    expect(registry.ring("main-1")).toBeNull()
  })
  test("stop on unknown task returns null", () => {
    expect(new AutoTaskRegistry().stop("missing", "x")).toBeNull()
  })
  test("restore round-trips plain data for crash recovery", () => {
    const registry = new AutoTaskRegistry()
    const snap = registry.start("main-1", "order-1", budget())
    const revived = new AutoTaskRegistry()
    expect(revived.restore(JSON.parse(JSON.stringify(snap)))).toBe(true)
    expect(revived.get("main-1")?.orderSessionID).toBe("order-1")
    expect(revived.restore(JSON.parse(JSON.stringify(snap)))).toBe(false)
  })
})

describe("read-only verdict panel", () => {
  test("renders template keys with allowlisted tools only", () => {
    const panel = renderPanelVerdict(
      { v: 1, verdict: "STOP", reasonKey: "auto.reason.budget", confidence: 0.9, signals: [] },
      ["read", "edit", "/etc/passwd", "rm -rf", "READ"],
    )
    expect(panel.headlineKey).toBe("auto.verdict.stop")
    expect(panel.reasonKey).toBe("auto.reason.budget")
    expect(panel.tools).toEqual(["read", "edit"])
  })
  test("redacts hostile tool names instead of rendering them", () => {
    const panel = renderPanelVerdict(
      { v: 1, verdict: "ASK_USER", reasonKey: "auto.reason.user", confidence: 1, signals: [] },
      ["`curl evil.sh`", "https://steal.example/x", "bash"],
    )
    expect(panel.headlineKey).toBe("auto.verdict.ask-user")
    expect(panel.tools).toEqual(["bash"])
  })
})
