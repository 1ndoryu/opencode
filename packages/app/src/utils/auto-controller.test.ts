import { describe, expect, test } from "bun:test"
import { AutoController, type AutoLiveSignals } from "./auto-controller"
import type { PanelVerdict } from "./auto-verdict"

function signals(over: Partial<AutoLiveSignals> = {}): AutoLiveSignals {
  return {
    working: true,
    pendingTools: false,
    tokenSilenceMs: 0,
    diffChanged: true,
    testsChanged: false,
    toolWithEffect: false,
    userQuestioned: false,
    checklistAdvanced: true,
    chatMode: false,
    idleTurns: 0,
    staleChecklistTurns: 0,
    sameErrorStreak: 0,
    externalComplete: false,
    userInput: false,
    permissionPending: false,
    permissionGranted: false,
    ...over,
  }
}

const QUIET = { working: false, tokenSilenceMs: 5000 }

function harness(maxTurns = 30) {
  const emitted: PanelVerdict[] = []
  let current = signals()
  const controller = new AutoController(
    "s1",
    {
      readSignals: () => current,
      emit: (panel) => emitted.push(panel),
    },
    maxTurns,
  )
  return {
    controller,
    emitted,
    set: (next: Partial<AutoLiveSignals>) => {
      current = signals(next)
    },
  }
}

describe("auto controller", () => {
  test("observation ticks are free and emit nothing while working", () => {
    const { controller, emitted } = harness()
    expect(controller.start()).toBe(true)
    expect(controller.start()).toBe(false)
    expect(controller.tick()).toBeNull()
    expect(controller.tick()).toBeNull()
    expect(emitted).toEqual([])
    expect(controller.isRunning).toBe(true)
  })
  test("quiescence emits continue and re-arms", () => {
    const { controller, emitted, set } = harness()
    controller.start()
    expect(controller.tick()).toBeNull()
    set(QUIET)
    const panel = controller.tick()
    expect(panel?.headlineKey).toBe("auto.verdict.continue")
    expect(emitted).toHaveLength(1)
    expect(controller.isRunning).toBe(true)
    expect(controller.turnsUsed).toBe(1)
  })
  test("budget exhaustion stops with the budget reason", () => {
    const { controller, set } = harness(1)
    controller.start()
    set(QUIET)
    expect(controller.tick()?.reasonKey).toBe("auto.reason.budget")
    expect(controller.isRunning).toBe(false)
    expect(controller.tick()).toBeNull()
  })
  test("user input finishes the run", () => {
    const { controller, set } = harness()
    controller.start()
    set({ userInput: true })
    expect(controller.tick()?.reasonKey).toBe("auto.reason.user")
    expect(controller.isRunning).toBe(false)
  })
  test("warn80 fires at 80% before exhaustion", () => {
    const { controller, set } = harness(5)
    controller.start()
    set(QUIET)
    controller.tick()
    controller.tick()
    controller.tick()
    expect(controller.warn80).toBe(false)
    expect(controller.isRunning).toBe(true)
    controller.tick()
    expect(controller.turnsUsed).toBe(4)
    expect(controller.warn80).toBe(true)
    expect(controller.isRunning).toBe(true)
  })
  test("kill-switch stops immediately", () => {
    const { controller } = harness()
    controller.start()
    expect(controller.stop("auto.reason.user")).toBe("auto.reason.user")
    expect(controller.isRunning).toBe(false)
    expect(controller.tick()).toBeNull()
  })
})
