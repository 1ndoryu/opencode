import { Schema } from "effect"

// Persistent auto-mode state, schema version 1. Stored per session via
// Persist.serverSession(scope, dir, sessionID, "auto", ["auto.v1"]).
// Bounded: encoded payload must stay under AUTO_STATE_MAX_BYTES.
export class AutoStateV1 extends Schema.Class<AutoStateV1>("AutoStateV1")({
  v: Schema.Literal("1"),
  enabled: Schema.Boolean,
  prompt: Schema.String,
  maxTurns: Schema.Number,
  turnCount: Schema.Number,
  costInput: Schema.Number,
  costOutput: Schema.Number,
  brief: Schema.Struct({
    lastVerdict: Schema.String,
    s1: Schema.Number,
    s2: Schema.Number,
    chatIdle: Schema.Number,
  }),
}) {}

export const AUTO_STATE_MAX_BYTES = 4096

const decodeState = Schema.decodeUnknownOption(AutoStateV1)
const encodeState = Schema.encodeOption(AutoStateV1)

export function defaultAutoState(prompt: string, maxTurns: number): AutoStateV1 {
  return new AutoStateV1({
    v: "1",
    enabled: false,
    prompt,
    maxTurns,
    turnCount: 0,
    costInput: 0,
    costOutput: 0,
    brief: { lastVerdict: "", s1: 0, s2: 0, chatIdle: 0 },
  })
}

// Unknown persisted value -> valid state or fresh default. Never throws:
// corrupt or oversized payloads fall back to default (fail-closed off).
export function readAutoState(value: unknown, prompt: string, maxTurns: number): AutoStateV1 {
  if (!record(value)) return defaultAutoState(prompt, maxTurns)
  const decoded = decodeState(value)
  if (decoded._tag === "None") return defaultAutoState(prompt, maxTurns)
  return decoded.value
}

export function autoStateSize(state: AutoStateV1): number {
  const encoded = encodeState(state)
  if (encoded._tag === "None") return Number.MAX_SAFE_INTEGER
  return new TextEncoder().encode(JSON.stringify(encoded.value)).length
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Closed steer grammar. No free-text instruction field: CONTINUE carries a
// goal enum plus workspace-verified hint refs only. Anything else is
// rejected by the server before reaching the main session.
export const SteerGoal = Schema.Literals(["continue", "request-input", "summarize"])

export class SteerContinue extends Schema.Class<SteerContinue>("AutoSteerContinue")({
  kind: Schema.Literal("continue"),
  goal: SteerGoal,
  hintRef: Schema.Array(Schema.String),
}) {}

export class SteerAskUser extends Schema.Class<SteerAskUser>("AutoSteerAskUser")({
  kind: Schema.Literal("ask-user"),
  question: Schema.String,
}) {}

export class SteerSummarize extends Schema.Class<SteerSummarize>("AutoSteerSummarize")({
  kind: Schema.Literal("summarize"),
}) {}

export class SteerStop extends Schema.Class<SteerStop>("AutoSteerStop")({
  kind: Schema.Literal("stop"),
  reason: Schema.String,
}) {}

export const AutoSteer = Schema.Union([SteerContinue, SteerAskUser, SteerSummarize, SteerStop]).annotate({
  discriminator: "kind",
  identifier: "AutoSteer",
})

export type AutoSteer = typeof AutoSteer.Type

const decodeSteer = Schema.decodeUnknownOption(AutoSteer)

export function readAutoSteer(value: unknown): AutoSteer | undefined {
  const decoded = decodeSteer(value)
  if (decoded._tag === "None") return undefined
  return decoded.value
}

// Server-side blocklist over the serialized steer. Fires -> downgrade to
// ask-user/stop, never steer. Structural validation (schema) is the first
// barrier; this is the second.
const BLOCKED_PATTERNS = [
  /(^|[\s"'`])(\/|~\/|[A-Za-z]:\\)[\w\-./\\]+/,
  /\b(rm|del|format|shutdown|reboot|mkfs|dd|chmod|chown|sudo|su|powershell|cmd\.exe)\b/i,
  /https?:\/\/[^\s"'`]+/,
  /[A-Za-z0-9+/]{80,}={0,2}/,
  /^diff --git|^--- |^\+\+\+ /m,
]

export function steerBlockedReason(steer: AutoSteer): string | undefined {
  const text = JSON.stringify(steer)
  const hit = BLOCKED_PATTERNS.find((pattern) => pattern.test(text))
  if (!hit) return undefined
  return `blocked pattern ${hit.source.slice(0, 48)}`
}

// Single-use steer token, stamped server-side. Replays and cross-turn reuse
// are rejected: nonce + turnId + expiry must all verify.
export class SteerToken extends Schema.Class<SteerToken>("AutoSteerToken")({
  nonce: Schema.String,
  turnId: Schema.String,
  exp: Schema.Number,
}) {}

// Port contracts. Implementations live server-side; AutoPolicy depends only
// on these shapes (see plan OP-38 rev.6).
export interface AutoDetectorInput {
  sessionID: string
  turnId: string
  diffHash: string
  testsChanged: boolean
  toolWithEffect: boolean
  userQuestioned: boolean
}

export interface AutoDetector {
  quiescent(input: AutoDetectorInput): boolean
}

export interface AutoLock {
  hold(sessionID: string): boolean
  release(sessionID: string): void
}

export interface AutoBudgetReserve {
  ok: boolean
  reason?: string
}

export interface AutoBudget {
  checkAndReserve(sessionID: string, estimate: number): AutoBudgetReserve
  spend(sessionID: string, input: number, output: number): void
}

export type EffectivePermission = "allow" | "ask" | "deny"

export interface AutoPermission {
  effective(sessionID: string): EffectivePermission
}

export interface AutoSteerSink {
  send(sessionID: string, steer: AutoSteer, token: SteerToken): void
}

// Binding policy verdict (plan OP-38 rev.6 anexo A). The orderer LLM is
// advisory; AutoPolicy maps signals to one of these and the machine stops
// the loop on anything but CONTINUE. reasonKey is always an i18n key.
export const AUTO_VERDICTS = ["CONTINUE", "ASK_USER", "SUMMARIZE", "STOP"] as const
export type AutoVerdict = (typeof AUTO_VERDICTS)[number]

export interface AutoPolicyState {
  v: 1
  verdict: AutoVerdict
  reasonKey: string
  confidence: number
  signals: string[]
}
