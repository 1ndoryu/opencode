import { AutoBudget } from "./auto-budget"
import { AutoMachine } from "./auto-machine"
import { AutoSummaryRing } from "./auto-summary"
// Ephemeral orderer session (OP-38 F1b). The orderer LLM runs in a second
// sessionID without state; policy state lives here keyed by sessionID.
// Everything is plain data so the host can persist and restore it next
// to serverSession; endSession wipes the orderer side completely.
export interface AutoTask {
  mainSessionID: string
  orderSessionID: string
  machine: AutoMachine
  budget: BudgetState
}

interface BudgetState {
  limits: { maxTurns: number; maxTokens: number; maxMs: number }
  turnsUsed: number
  tokensUsed: number
  startedAt: number
  closed: boolean
}

export interface AutoTaskSnapshot {
  mainSessionID: string
  orderSessionID: string
  machineState: ReturnType<AutoMachine["current"]>
  budget: BudgetState
}

export class AutoTaskRegistry {
  private tasks = new Map<string, { task: AutoTask; ring: AutoSummaryRing }>()

  start(mainSessionID: string, orderSessionID: string, budget: AutoBudget): AutoTaskSnapshot {
    const snap = budget.snapshot()
    const task: AutoTask = {
      mainSessionID,
      orderSessionID,
      machine: new AutoMachine(),
      budget: {
        limits: { maxTurns: 30, maxTokens: 120_000, maxMs: 1_200_000 },
        turnsUsed: snap.turnsUsed,
        tokensUsed: snap.tokensUsed,
        startedAt: Date.now(),
        closed: false,
      },
    }
    this.tasks.set(mainSessionID, { task, ring: new AutoSummaryRing() })
    return this.snapshot(mainSessionID)!
  }

  get(mainSessionID: string): AutoTask | null {
    return this.tasks.get(mainSessionID)?.task ?? null
  }

  ring(mainSessionID: string): AutoSummaryRing | null {
    return this.tasks.get(mainSessionID)?.ring ?? null
  }

  snapshot(mainSessionID: string): AutoTaskSnapshot | null {
    const entry = this.tasks.get(mainSessionID)
    if (!entry) return null
    return {
      mainSessionID: entry.task.mainSessionID,
      orderSessionID: entry.task.orderSessionID,
      machineState: entry.task.machine.current(),
      budget: { ...entry.task.budget },
    }
  }

  // Stop wipes the orderer side: machine settles, ring clears, task drops.
  // Returns the resumable closing text from the budget.
  stop(mainSessionID: string, reason: string): string | null {
    const entry = this.tasks.get(mainSessionID)
    if (!entry) return null
    entry.task.machine.settle()
    entry.task.budget.closed = true
    const text =
      `auto stopped (${reason}): ${entry.task.budget.turnsUsed} turns, ` +
      `${entry.task.budget.tokensUsed} tokens. Resume with the same goal to continue.`
    entry.ring.clearSession(entry.task.orderSessionID)
    this.tasks.delete(mainSessionID)
    return text
  }

  restore(snapshot: AutoTaskSnapshot): boolean {
    if (this.tasks.has(snapshot.mainSessionID)) return false
    const task: AutoTask = {
      mainSessionID: snapshot.mainSessionID,
      orderSessionID: snapshot.orderSessionID,
      machine: new AutoMachine(),
      budget: { ...snapshot.budget },
    }
    this.tasks.set(snapshot.mainSessionID, { task, ring: new AutoSummaryRing() })
    return true
  }
}
