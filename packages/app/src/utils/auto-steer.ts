import { createHmac, timingSafeEqual } from "node:crypto"
// Server-side steer grammar for auto mode (OP-38 F3b). Closed grammar:
// no free text may reach the main session. Validation is strict and
// fail-closed; stamping adds nonce + turnId + expiry server-side.
export const AUTO_STEER_GOALS = ["continue", "ask-user", "summarize", "stop"] as const
export type AutoSteerGoal = (typeof AUTO_STEER_GOALS)[number]

export interface AutoSteerRequest {
  goal: unknown
  hintRef: unknown
}

export interface AutoSteer {
  goal: AutoSteerGoal
  hintRef: string[]
  nonce: string
  turnId: string
  exp: number
}

const HINT_ID = /^[a-z][a-z0-9-]{0,63}$/
const MAX_HINTS = 8
const STEER_TTL_MS = 60_000

const BLOCKLIST = [
  /`[^`]*`/, // inline commands
  /(^|\s)(\/|[a-zA-Z]:[\\/]|\.{0,2}\/)[\w.~/-]+/, // absolute/relative paths and urls
  /https?:\/\//i,
  /[A-Za-z0-9+/]{64,}={0,2}/, // long base64 blobs
  /^diff --git/m,
]

let nonceCounter = 0

export function validateSteerGoal(goal: unknown): AutoSteerGoal | null {
  return typeof goal === "string" && (AUTO_STEER_GOALS as readonly string[]).includes(goal)
    ? (goal as AutoSteerGoal)
    : null
}

export function validateHintRef(hintRef: unknown): string[] | null {
  if (!Array.isArray(hintRef) || hintRef.length > MAX_HINTS) return null
  const ids: string[] = []
  for (const item of hintRef) {
    if (typeof item !== "string" || !HINT_ID.test(item)) return null
    for (const pattern of BLOCKLIST) if (pattern.test(item)) return null
    ids.push(item)
  }
  return ids
}

// Returns a stamped steer or null. Never throws, never passes text through.
export function buildSteer(request: AutoSteerRequest, turnId: string): AutoSteer | null {
  const goal = validateSteerGoal(request.goal)
  const hintRef = validateHintRef(request.hintRef)
  if (goal === null || hintRef === null || typeof turnId !== "string" || turnId.length === 0) return null
  nonceCounter += 1
  return { goal, hintRef, nonce: `n${Date.now().toString(36)}-${nonceCounter}`, turnId, exp: Date.now() + STEER_TTL_MS }
}

export function isSteerFresh(steer: AutoSteer, turnId: string, now = Date.now()): boolean {
  return steer.turnId === turnId && now <= steer.exp
}

function tokenPayload(turnId: string, exp: number): string {
  return `${turnId}.${exp}`
}

export function issueSteerToken(turnId: string, secret: string, now = Date.now()): string {
  const exp = now + STEER_TTL_MS
  const mac = createHmac("sha256", secret).update(tokenPayload(turnId, exp)).digest("hex")
  return `${tokenPayload(turnId, exp)}.${mac}`
}

export function isSteerTokenValid(token: string, turnId: string, secret: string, now = Date.now()): boolean {
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [tokenTurn, expRaw, mac] = parts
  const exp = Number(expRaw)
  if (!Number.isInteger(exp) || tokenTurn !== turnId || now > exp) return false
  const expected = createHmac("sha256", secret).update(tokenPayload(tokenTurn, exp)).digest("hex")
  if (expected.length !== mac.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
}
