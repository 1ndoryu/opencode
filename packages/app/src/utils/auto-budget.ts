// Atomic task budget for auto mode (OP-38 F3b). Single-owner: the check
// and the reserve happen in one synchronous call, so no interleave can
// over-spend. JS run-to-completion makes the sync section atomic; the
// class additionally refuses use after close.
export interface BudgetLimits {
  maxTurns: number
  maxTokens: number
  maxMs: number
}

export interface BudgetEstimate {
  turns: number
  tokens: number
}

export type ReserveResult = { ok: true } | { ok: false; reason: "turns" | "tokens" | "time" | "closed" }

export interface BudgetSnapshot {
  turnsUsed: number
  tokensUsed: number
  elapsedMs: number
  warn80: boolean
  exhausted: boolean
}

const WARN_RATIO = 0.8

export class AutoBudget {
  private turnsUsed = 0
  private tokensUsed = 0
  private readonly startedAt = Date.now()
  private closed = false

  constructor(private readonly limits: BudgetLimits) {}

  // Atomic: check + reserve in one sync step.
  reserve(estimate: BudgetEstimate): ReserveResult {
    if (this.closed) return { ok: false, reason: "closed" }
    if (Date.now() - this.startedAt >= this.limits.maxMs) return { ok: false, reason: "time" }
    if (this.turnsUsed + estimate.turns > this.limits.maxTurns) return { ok: false, reason: "turns" }
    if (this.tokensUsed + estimate.tokens > this.limits.maxTokens) return { ok: false, reason: "tokens" }
    this.turnsUsed += estimate.turns
    this.tokensUsed += estimate.tokens
    return { ok: true }
  }

  snapshot(): BudgetSnapshot {
    const elapsedMs = Date.now() - this.startedAt
    const exhausted =
      this.turnsUsed >= this.limits.maxTurns ||
      this.tokensUsed >= this.limits.maxTokens ||
      elapsedMs >= this.limits.maxMs
    const warn80 =
      this.turnsUsed / this.limits.maxTurns >= WARN_RATIO ||
      this.tokensUsed / this.limits.maxTokens >= WARN_RATIO
    return { turnsUsed: this.turnsUsed, tokensUsed: this.tokensUsed, elapsedMs, warn80, exhausted }
  }

  // Closing heuristic + resumable message. Call once; further reserves fail.
  close(reason: string): { summary: string; resumeHint: string } {
    this.closed = true
    const snap = this.snapshot()
    const summary = `auto closed (${reason}): ${snap.turnsUsed} turns, ${snap.tokensUsed} tokens, ${Math.round(snap.elapsedMs / 1000)}s`
    const resumeHint = `Resume with the same goal; progress so far: ${snap.turnsUsed} turns consumed. Last state: ${reason}.`
    return { summary, resumeHint }
  }
}
