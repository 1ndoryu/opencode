import { describe, expect, test } from "bun:test"
import { AutoMachine } from "./auto-machine"

function quiescent(machine: AutoMachine) {
  machine.markGenerating()
  return machine.observe({ working: false, pendingTools: false, tokenSilenceMs: 5000 })
}

describe("quiescence triple", () => {
  test("reaches QUIESCENTE only with idle + no tools + silence", () => {
    const machine = new AutoMachine()
    machine.markGenerating()
    expect(machine.observe({ working: true, pendingTools: false, tokenSilenceMs: 9000 })).toBe("GENERATING")
    expect(machine.observe({ working: false, pendingTools: true, tokenSilenceMs: 9000 })).toBe("GENERATING")
    expect(machine.observe({ working: false, pendingTools: false, tokenSilenceMs: 100 })).toBe("GENERATING")
    expect(machine.observe({ working: false, pendingTools: false, tokenSilenceMs: 5000 })).toBe("QUIESCENTE")
  })
  test("reconcile covers a stuck working flag without terminal event", () => {
    const machine = new AutoMachine({ quiescentSilenceMs: 60_000, reconcileTimeoutMs: 1000 })
    machine.markGenerating()
    machine.observe({ working: true, pendingTools: false, tokenSilenceMs: 0 }, 0)
    expect(machine.observe({ working: false, pendingTools: false, tokenSilenceMs: 0 }, 500)).toBe("GENERATING")
    expect(machine.observe({ working: false, pendingTools: false, tokenSilenceMs: 0 }, 2000)).toBe("QUIESCENTE")
  })
})

describe("wake coalescing", () => {
  test("double wake produces a single steer", () => {
    const machine = new AutoMachine()
    quiescent(machine)
    expect(machine.wake()).toBe(true)
    expect(machine.wake()).toBe(false)
    expect(machine.wake()).toBe(false)
    expect(machine.coalescedWakes).toBe(3)
    expect(machine.queueForInjection()).toBe(true)
    const turn = machine.beginTurn()
    expect(machine.consumeSteer("tok-1", turn)).toBe(true)
  })
  test("wakes outside QUIESCENTE do nothing", () => {
    const machine = new AutoMachine()
    expect(machine.wake()).toBe(false)
    machine.markGenerating()
    expect(machine.wake()).toBe(false)
  })
})

describe("input priority", () => {
  test("input cancels ordered and queued work", () => {
    const ordered = new AutoMachine()
    quiescent(ordered)
    ordered.wake()
    expect(ordered.notifyInput()).toBe(true)
    expect(ordered.current()).toBe("IDLE")
    const queued = new AutoMachine()
    quiescent(queued)
    queued.wake()
    queued.queueForInjection()
    expect(queued.notifyInput()).toBe(true)
    expect(queued.current()).toBe("IDLE")
  })
  test("input is ignored once the steer fired", () => {
    const machine = new AutoMachine()
    quiescent(machine)
    machine.wake()
    machine.queueForInjection()
    const turn = machine.beginTurn()
    machine.consumeSteer("tok-1", turn)
    expect(machine.notifyInput()).toBe(false)
    expect(machine.current()).toBe("INYECTADO")
  })
})

describe("single-use token", () => {
  test("replay of the same token is rejected", () => {
    const machine = new AutoMachine()
    quiescent(machine)
    machine.wake()
    machine.queueForInjection()
    const turn = machine.beginTurn()
    expect(machine.consumeSteer("tok-1", turn)).toBe(true)
    expect(machine.consumeSteer("tok-1", turn)).toBe(false)
  })
  test("stale turn is rejected", () => {
    const machine = new AutoMachine()
    quiescent(machine)
    machine.wake()
    machine.queueForInjection()
    machine.beginTurn()
    expect(machine.consumeSteer("tok-1", "auto-turn-9999")).toBe(false)
  })
})

describe("mutex", () => {
  test("hold is indivisible until expiry", () => {
    const machine = new AutoMachine({ mutexTtlMs: 1000 })
    const first = machine.acquire("orderer", 0)
    expect(first).not.toBeNull()
    expect(machine.acquire("other", 500)).toBeNull()
    expect(machine.release("wrong-token")).toBe(false)
    expect(machine.release(first!.token)).toBe(true)
    expect(machine.acquire("other", 500)).not.toBeNull()
  })
  test("expired hold can be taken over", () => {
    const machine = new AutoMachine({ mutexTtlMs: 1000 })
    machine.acquire("orderer", 0)
    expect(machine.acquire("other", 1001)).not.toBeNull()
  })
})
