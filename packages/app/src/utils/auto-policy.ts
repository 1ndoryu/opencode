// Pure convergence policy for auto mode (OP-38 F3a). No I/O, no LLM:
// decides from externally observed signals only. The orderer LLM is
// advisory; this function is the binding stop authority.
export type AutoConvergence =
  | "progress"
  | "complete"
  | "blocked-no-advance"
  | "blocked-budget"
  | "blocked-permission"
  | "blocked-user"
  | "needs-summary"

export interface AutoSignals {
  // Turn bookkeeping (system-owned, monotonic)
  turn: number
  maxTurns: number
  tokensOk: boolean
  timeOk: boolean
  // Last main-turn action signature, already normalized by caller
  signature: string
  recentSignatures: string[]
  // External progress signals (never LLM opinion)
  diffChanged: boolean
  testsChanged: boolean
  toolWithEffect: boolean
  userQuestioned: boolean
  checklistAdvanced: boolean
  // Mode + stalls
  chatMode: boolean
  idleTurns: number
  staleChecklistTurns: number
  sameErrorStreak: number
  externalComplete: boolean
  // Interrupts
  userInput: boolean
  permissionPending: boolean
  permissionGranted: boolean
}

export const AUTO_S1_THRESHOLD = 0.9
export const AUTO_S1_REPEATS = 3
export const AUTO_S2_STALLS = 3
export const AUTO_CHAT_IDLE_TURNS = 5
export const AUTO_SAME_ERROR = 3

// Mechanical similarity: lowercase, collapse whitespace/punctuation,
// sort lines, round numbers. Catches spacing/case/quote paraphrases of
// tool calls; true semantic paraphrase of prose is NOT caught here by
// design (covered by S2 external signals instead).
export function normalizeSignature(raw: string): string {
  const rounded = raw.toLowerCase().replace(/\d+\.\d+/g, (n) => (Math.round(Number(n) * 100) / 100).toString())
  const tokens = rounded
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 0)
    .sort()
  return tokens.join(" ")
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((t) => t.length > 0))
}

// Overlap coefficient: |A∩B| / min(|A|,|B|). 1.0 = one is subset of other.
export function signatureSimilarity(a: string, b: string): number {
  const left = tokenSet(normalizeSignature(a))
  const right = tokenSet(normalizeSignature(b))
  if (left.size === 0 || right.size === 0) return 0
  let inter = 0
  for (const token of left) if (right.has(token)) inter++
  return inter / Math.min(left.size, right.size)
}

export function countRepeats(signature: string, recent: string[]): number {
  let count = 0
  for (const prev of recent) {
    if (signatureSimilarity(signature, prev) >= AUTO_S1_THRESHOLD) count++
  }
  return count
}

export function converge(signals: AutoSignals): AutoConvergence {
  if (signals.turn >= signals.maxTurns) return "blocked-budget"
  if (!signals.tokensOk) return "blocked-budget"
  if (!signals.timeOk) return "blocked-budget"
  if (signals.userInput) return "blocked-user"
  if (signals.permissionPending && !signals.permissionGranted) return "blocked-permission"
  if (signals.externalComplete) return "complete"
  if (signals.sameErrorStreak >= AUTO_SAME_ERROR) return "blocked-user"
  if (signals.chatMode) {
    const advanced =
      signals.diffChanged || signals.testsChanged || signals.toolWithEffect || signals.userQuestioned
    if (!advanced && signals.idleTurns >= AUTO_CHAT_IDLE_TURNS) return "blocked-no-advance"
    return "progress"
  }
  if (!signals.checklistAdvanced && signals.staleChecklistTurns >= AUTO_S2_STALLS) return "blocked-no-advance"
  const noExternal =
    !signals.diffChanged && !signals.testsChanged && !signals.toolWithEffect && !signals.userQuestioned
  if (noExternal && signals.idleTurns >= AUTO_S2_STALLS) return "blocked-no-advance"
  if (countRepeats(signals.signature, signals.recentSignatures) >= AUTO_S1_REPEATS) return "blocked-no-advance"
  return "progress"
}

function baseSignals(over: Partial<AutoSignals>): AutoSignals {
  return {
    turn: 1,
    maxTurns: 30,
    tokensOk: true,
    timeOk: true,
    signature: "read src/a.ts",
    recentSignatures: [],
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

export const autoPolicyTestBase = baseSignals
