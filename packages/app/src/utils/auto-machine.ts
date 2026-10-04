// Auto-mode state machine (OP-38 F1a). Decoupled by design: it never
// touches the session store or timeline. The host injects signals
// (working, pending tools, token silence) and consumes at most one steer
// per wake. All transitions are synchronous and unit-testable.
export type AutoMachineState = "IDLE" | "GENERATING" | "QUIESCENTE" | "ORDENADOR" | "ENCOLADO" | "INYECTADO"

export interface QuiescentSignals {
  working: boolean
  pendingTools: boolean
  tokenSilenceMs: number
}

export interface MachineOptions {
  quiescentSilenceMs?: number
  reconcileTimeoutMs?: number
  mutexTtlMs?: number
}

export interface MutexHold {
  owner: string
  token: string
  expiresAt: number
}

let holdCounter = 0
let turnCounter = 0

export class AutoMachine {
  private state: AutoMachineState = "IDLE"
  private hold: MutexHold | null = null
  private turnId: string | null = null
  private spentToken: string | null = null
  private pendingWakes = 0
  private lastWorkingFalseAt: number | null = null
  private readonly quietMs: number
  private readonly reconcileMs: number
  private readonly mutexMs: number

  constructor(options: MachineOptions = {}) {
    this.quietMs = options.quiescentSilenceMs ?? 2000
    this.reconcileMs = options.reconcileTimeoutMs ?? 10_000
    this.mutexMs = options.mutexTtlMs ?? 30_000
  }

  current(): AutoMachineState {
    return this.state
  }

  currentTurn(): string | null {
    return this.turnId
  }

  // Indivisible compare-and-set: only one owner holds the mutex.
  acquire(owner: string, now = Date.now()): MutexHold | null {
    if (this.hold && now <= this.hold.expiresAt) return null
    holdCounter += 1
    this.hold = { owner, token: `hold-${holdCounter}`, expiresAt: now + this.mutexMs }
    return { ...this.hold }
  }

  release(token: string): boolean {
    if (!this.hold || this.hold.token !== token) return false
    this.hold = null
    return true
  }

  beginTurn(): string {
    turnCounter += 1
    this.turnId = `auto-turn-${turnCounter}`
    this.spentToken = null
    return this.turnId
  }

  // Host calls this on every status tick. QUIESCENTE needs the triple:
  // working idle + no pending tools + token silence; reconcile covers a
  // working flag stuck false without a terminal event.
  observe(signals: QuiescentSignals, now = Date.now()): AutoMachineState {
    if (signals.working) this.lastWorkingFalseAt = null
    if (!signals.working && this.lastWorkingFalseAt === null) this.lastWorkingFalseAt = now
    if (this.state !== "GENERATING") return this.state
    const silent = signals.tokenSilenceMs >= this.quietMs
    const reconciled =
      this.lastWorkingFalseAt !== null && now - this.lastWorkingFalseAt >= this.reconcileMs
    if (!signals.working && !signals.pendingTools && (silent || reconciled)) this.state = "QUIESCENTE"
    return this.state
  }

  markGenerating(): void {
    if (this.state === "IDLE") this.state = "GENERATING"
  }

  // Orderer tick. Coalesces: any number of wakes in ORDENADOR/ENCOLADO
  // still produce a single steer; IDLE/GENERATING wakes are ignored.
  wake(): boolean {
    if (this.state === "QUIESCENTE") {
      this.state = "ORDENADOR"
      this.pendingWakes = 1
      return true
    }
    if (this.state === "ORDENADOR" || this.state === "ENCOLADO") {
      this.pendingWakes += 1
      return false
    }
    return false
  }

  queueForInjection(): boolean {
    if (this.state !== "ORDENADOR") return false
    this.state = "ENCOLADO"
    return true
  }

  // Single-use steer token: first consume wins; replays are rejected so
  // an injected steer can never fire twice.
  consumeSteer(token: string, turnId: string): boolean {
    if (this.state !== "ENCOLADO") return false
    if (this.spentToken !== null) return false
    if (this.turnId === null || turnId !== this.turnId) return false
    this.spentToken = token
    this.pendingWakes = 0
    this.state = "INYECTADO"
    return true
  }

  // User input wins: cancels ordered/queued work, ignored once injected
  // because the single-use token already fired.
  notifyInput(): boolean {
    if (this.state === "ORDENADOR" || this.state === "ENCOLADO") {
      this.state = "IDLE"
      this.pendingWakes = 0
      return true
    }
    return false
  }

  settle(): void {
    if (this.state === "INYECTADO" || this.state === "QUIESCENTE") this.state = "IDLE"
  }

  get coalescedWakes(): number {
    return this.pendingWakes
  }
}
