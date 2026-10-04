// Bounded summary ring for auto mode (OP-38 F3b). Crash-safe by design:
// fixed cap, oldest-first eviction, plain data only (no functions, no
// DOM). The host persists the exported array next to serverSession.
export interface AutoSummaryEntry {
  at: number
  sessionID: string
  verdict: string
  detail: string
}

export const AUTO_SUMMARY_CAP = 50

export class AutoSummaryRing {
  private entries: AutoSummaryEntry[] = []

  constructor(seed: AutoSummaryEntry[] = []) {
    for (const entry of seed.slice(-AUTO_SUMMARY_CAP)) this.entries.push({ ...entry })
  }

  push(sessionID: string, verdict: string, detail: string): void {
    this.entries.push({ at: Date.now(), sessionID, verdict, detail: detail.slice(0, 500) })
    while (this.entries.length > AUTO_SUMMARY_CAP) this.entries.shift()
  }

  forSession(sessionID: string): AutoSummaryEntry[] {
    return this.entries.filter((entry) => entry.sessionID === sessionID)
  }

  export(): AutoSummaryEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  clearSession(sessionID: string): void {
    this.entries = this.entries.filter((entry) => entry.sessionID !== sessionID)
  }

  get size(): number {
    return this.entries.length
  }
}
