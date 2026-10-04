import { AutoBudget } from "./auto-budget"
import { AutoMachine } from "./auto-machine"
import { type AutoConvergence, converge } from "./auto-policy"
import { AutoSummaryRing } from "./auto-summary"
import { type AutoPolicyState, type AutoVerdict } from "./auto-contract"
import { type PanelVerdict, renderPanelVerdict } from "./auto-verdict"

// Observation-only auto driver (OP-38 F0). Binds the registry, machine,
// budget, policy and verdict panel to live status ticks. It never injects
// prompts: ordering/injection needs the server-side steer path (open
// follow-up), so ticks only observe, budget and stop.
export interface AutoLiveSignals {
  working: boolean
  pendingTools: boolean
  tokenSilenceMs: number
  diffChanged: boolean
  testsChanged: boolean
  toolWithEffect: boolean
  userQuestioned: boolean
  checklistAdvanced: boolean
  chatMode: boolean
  idleTurns: number
  staleChecklistTurns: number
  sameErrorStreak: number
  externalComplete: boolean
  userInput: boolean
  permissionPending: boolean
  permissionGranted: boolean
}

export interface AutoControllerHooks {
  readSignals(): AutoLiveSignals
  emit(verdict: PanelVerdict): void
}

const TURN_TOKENS = 120_000
const MAX_TOKENS = 3_600_000
const MAX_MS = 1_200_000

const REASON_KEYS: Record<AutoConvergence, string> = {
  progress: "auto.verdict.continue",
  complete: "auto.reason.complete",
  "blocked-no-advance": "auto.reason.no-advance",
  "blocked-budget": "auto.reason.budget",
  "blocked-permission": "auto.reason.permission",
  "blocked-user": "auto.reason.user",
  "needs-summary": "auto.verdict.summarize",
}

const POLICY_VERDICT: Record<AutoConvergence, AutoVerdict> = {
  progress: "CONTINUE",
  complete: "STOP",
  "blocked-no-advance": "STOP",
  "blocked-budget": "STOP",
  "blocked-permission": "ASK_USER",
  "blocked-user": "STOP",
  "needs-summary": "SUMMARIZE",
}

export class AutoController {
  private machine = new AutoMachine()
  private budget: AutoBudget | null = null
  private ring = new AutoSummaryRing()
  private turn = 0
  private recent: string[] = []
  private running = false
  private stopText: string | null = null

  constructor(
    private readonly sessionID: string,
    private readonly hooks: AutoControllerHooks,
    private readonly maxTurns = 30,
  ) {}

  start(): boolean {
    if (this.running) return false
    this.budget = new AutoBudget({ maxTurns: this.maxTurns, maxTokens: MAX_TOKENS, maxMs: MAX_MS })
    this.turn = 0
    this.recent = []
    this.stopText = null
    this.machine = new AutoMachine()
    this.machine.markGenerating()
    this.running = true
    return true
  }

  tick(): PanelVerdict | null {
    if (!this.running || !this.budget) return null
    const live = this.hooks.readSignals()
    this.machine.observe({
      working: live.working,
      pendingTools: live.pendingTools,
      tokenSilenceMs: live.tokenSilenceMs,
    })
    if (live.userInput) {
      this.machine.notifyInput()
      return this.finish("auto.reason.user")
    }
    // Observation ticks are free; only a reached QUIESCENTE spends one
    // orderer turn. wake()/consumeSteer() stay reserved for the future
    // server-side injection driver and are never called here.
    if (this.machine.current() !== "QUIESCENTE") return null
    const reserve = this.budget.reserve({ turns: 1, tokens: TURN_TOKENS })
    if (!reserve.ok) return this.finish("auto.reason.budget")
    this.turn += 1
    const snap = this.budget.snapshot()
    const convergence = converge({
      turn: this.turn,
      maxTurns: this.maxTurns,
      tokensOk: !snap.exhausted,
      timeOk: !snap.exhausted,
      signature: `turn-${this.turn}`,
      recentSignatures: this.recent,
      diffChanged: live.diffChanged,
      testsChanged: live.testsChanged,
      toolWithEffect: live.toolWithEffect,
      userQuestioned: live.userQuestioned,
      checklistAdvanced: live.checklistAdvanced,
      chatMode: live.chatMode,
      idleTurns: live.idleTurns,
      staleChecklistTurns: live.staleChecklistTurns,
      sameErrorStreak: live.sameErrorStreak,
      externalComplete: live.externalComplete,
      userInput: false,
      permissionPending: live.permissionPending,
      permissionGranted: live.permissionGranted,
    })
    this.recent.push(`turn-${this.turn}`)
    if (convergence !== "progress") return this.finish(REASON_KEYS[convergence])
    const state: AutoPolicyState = {
      v: 1,
      verdict: POLICY_VERDICT[convergence],
      reasonKey: REASON_KEYS[convergence],
      confidence: 1,
      signals: [],
    }
    const panel = renderPanelVerdict(state, [])
    this.ring.push(this.sessionID, convergence, `turn ${this.turn}`)
    this.machine.settle()
    this.machine.markGenerating()
    this.hooks.emit(panel)
    return panel
  }

  // Kill-switch: immediate, always honors.
  stop(reasonKey: string): string {
    const text = this.finish(reasonKey)
    return text?.reasonKey ?? reasonKey
  }

  private finish(reasonKey: string): PanelVerdict | null {
    if (!this.running) return null
    this.running = false
    const closing = this.budget?.close(reasonKey)
    this.stopText = closing?.summary ?? reasonKey
    this.machine.settle()
    const panel: PanelVerdict = {
      headlineKey: "auto.verdict.stop",
      reasonKey,
      tools: [],
    }
    this.hooks.emit(panel)
    return panel
  }

  get isRunning(): boolean {
    return this.running
  }

  get turnsUsed(): number {
    return this.turn
  }

  // 80% budget aviso for the panel (DoD F0). True once any capped
  // dimension (turns or tokens) reaches WARN_RATIO, before exhaustion.
  get warn80(): boolean {
    return this.budgetSnapshot()?.warn80 ?? false
  }

  budgetSnapshot() {
    return this.budget?.snapshot() ?? null
  }
}
