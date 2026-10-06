import { Effect, Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { SessionID } from "./schema"
import { Storage } from "@/storage/storage"

export const MAX_STEERS = 30
export const NO_PROGRESS_TURNS = 3
export const REMINDER = `[Auto] Al cerrar tu turno escribe en la última línea exacta ESTADO: COMPLETO si la tarea terminó, ESTADO: BLOQUEADO: <motivo> si no puedes seguir, o ESTADO: SIGUE: <siguiente paso> si queda trabajo. No preguntes al usuario: elige la opción recomendada.`
export const DECIDER_TIMEOUT_MS = 120_000
export const DECIDER_SNAPSHOT_CHARS = 1000
export const DECIDER_INSTRUCTION_CHARS = 280

export interface State {
  readonly enabled: boolean
  readonly goal?: string | undefined
}

export function defaultState(): State {
  return { enabled: true }
}

const key = (sessionID: SessionID) => ["auto", sessionID]

export const get = Effect.fn("SessionAuto.get")(function* (sessionID: SessionID) {
  const storage = yield* Storage.Service
  const stored = yield* storage.read<State>(key(sessionID)).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed<State>(defaultState())),
    Effect.orDie,
  )
  return {
    enabled: stored.enabled ?? true,
    ...(typeof stored.goal === "string" ? { goal: stored.goal } : {}),
  } satisfies State
})

export const set = Effect.fn("SessionAuto.set")(function* (
  sessionID: SessionID,
  patch: { enabled: boolean; goal: string | undefined },
) {
  const storage = yield* Storage.Service
  const next: State = {
    enabled: patch.enabled,
    ...(patch.goal === undefined ? {} : { goal: patch.goal }),
  }
  yield* storage.write(key(sessionID), next).pipe(Effect.orDie)
  return next
})

export interface ExitPart {
  readonly type: string
  readonly text?: string | undefined
  readonly synthetic?: boolean | undefined
  readonly metadata?: unknown
  readonly tool?: string | undefined
}

export interface ExitMessage {
  readonly info: { readonly role: "user" | "assistant"; readonly id?: string | undefined; readonly error?: unknown }
  readonly parts: readonly ExitPart[]
}

function assistantTurns(messages: readonly ExitMessage[]) {
  return messages.filter((msg) => msg.info.role === "assistant")
}

function hasToolCall(turn: ExitMessage) {
  return turn.parts.some((part) => part.type === "tool")
}

export function assistantText(turn: ExitMessage) {
  return turn.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
}

function isAutoSteer(part: Pick<ExitPart, "metadata">) {
  if (typeof part.metadata !== "object" || part.metadata === null) return false
  return "auto" in part.metadata && part.metadata.auto === "steer"
}

export function steersSinceUser(messages: readonly ExitMessage[]) {
  let n = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.info.role !== "user") continue
    if (msg.parts.some(isAutoSteer)) n += 1
    else break
  }
  return n
}

export function parseEstado(text: string) {
  const match = text.match(/^ESTADO:\s*(COMPLETO|BLOQUEADO|SIGUE)(?::\s*(.+))?\s*$/m)
  if (!match) return undefined
  if (match[1] === "COMPLETO") return { done: true as const, motivo: undefined as string | undefined }
  if (match[1] === "BLOQUEADO")
    return { done: true as const, motivo: (match[2]?.trim() || "bloqueado") as string | undefined }
  return { done: false as const }
}

export interface Stop {
  readonly action: "stop"
  readonly motivo?: string | undefined
  readonly n: number
}
export interface Continue {
  readonly action: "continue"
  readonly n: number
}
export type Exit = Stop | Continue

function stop(n: number, motivo?: string): Exit {
  return motivo === undefined ? { action: "stop", n } : { action: "stop", motivo, n }
}

export function evaluateExit(input: { enabled: boolean; messages: readonly ExitMessage[] }): Exit {
  const n = steersSinceUser(input.messages)
  if (!input.enabled) return stop(n)
  if (n >= MAX_STEERS) return stop(n, `límite ${MAX_STEERS} intentos`)
  const last = [...input.messages].reverse().find((msg) => msg.info.role === "assistant")
  if (last) {
    if (last.info.error) return stop(n, "error del asistente")
    const estado = parseEstado(assistantText(last))
    if (estado?.done) return stop(n, estado.motivo)
  }
  const recent = assistantTurns(input.messages).slice(-NO_PROGRESS_TURNS)
  if (recent.length >= NO_PROGRESS_TURNS) {
    if (!recent.some(hasToolCall)) return stop(n, "sin avance")
    const first = assistantText(recent[0]!)
    if (recent.every((turn) => assistantText(turn) === first)) return stop(n, "sin avance")
  }
  return { action: "continue", n }
}

export function nudgeText(n: number, goal?: string) {
  const head = `[Auto ${n}/${MAX_STEERS}] Continúa con la tarea${goal ? `: ${goal}` : ""}.`
  return `${head} No preguntes: elige la opción recomendada y sigue. Cierra el turno con ESTADO: COMPLETO, BLOQUEADO o SIGUE.`
}

export function steerText(n: number, instruction: string) {
  return `[Auto ${n}/${MAX_STEERS}] ${instruction}`
}

export interface Decision {
  readonly order: "continuar" | "terminar"
  readonly instruction: string
}

export function parseDecision(text: string): Decision | undefined {
  const order = text.match(/^ORDEN:\s*(continuar|terminar)\s*$/im)?.[1]?.toLowerCase()
  if (order !== "continuar" && order !== "terminar") return undefined
  const instruction = text.match(/^INSTRUCCION:\s*(.+?)\s*$/im)?.[1]?.trim()
  if (!instruction) return undefined
  return {
    order,
    instruction:
      instruction.length > DECIDER_INSTRUCTION_CHARS ? instruction.slice(0, DECIDER_INSTRUCTION_CHARS) : instruction,
  }
}

export type DecideResult =
  | { readonly kind: "steer"; readonly text: string }
  | { readonly kind: "stop"; readonly motivo: string }
  | { readonly kind: "fallback" }

export type DecideStep =
  | { readonly action: "continue"; readonly text: string; readonly fails: number }
  | { readonly action: "stop"; readonly motivo?: string | undefined; readonly fails: number }

export function stepAfterDecide(input: {
  fails: number
  n: number
  goal?: string
  result: DecideResult
}): DecideStep {
  if (input.result.kind === "stop") return { action: "stop", motivo: input.result.motivo, fails: 0 }
  if (input.result.kind === "steer") return { action: "continue", text: input.result.text, fails: 0 }
  const fails = input.fails + 1
  if (fails >= 2) return { action: "stop", motivo: "decider sin respuesta", fails }
  return { action: "continue", text: nudgeText(input.n, input.goal), fails }
}

function truncate(text: string, max: number) {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export function deciderSnapshot(input: { goal?: string; messages: readonly ExitMessage[] }) {
  const lastUser = [...input.messages]
    .reverse()
    .find((msg) => msg.info.role === "user" && !msg.parts.some(isAutoSteer))
  const assistants = input.messages.filter((msg) => msg.info.role === "assistant").slice(-2)
  const userText = lastUser ? truncate(assistantText(lastUser), DECIDER_SNAPSHOT_CHARS) : "—"
  const assistantTexts = assistants
    .map((turn) => truncate(assistantText(turn), DECIDER_SNAPSHOT_CHARS))
    .filter((text) => text.length > 0)
  return [
    `Objetivo: ${input.goal?.trim() || "—"}`,
    "",
    "Último mensaje del usuario:",
    userText || "—",
    "",
    "Últimos mensajes del asistente:",
    assistantTexts.length > 0 ? assistantTexts.join("\n---\n") : "—",
  ].join("\n")
}

export const AutoEvent = Event.define({
  type: "session.auto",
  schema: {
    sessionID: SessionID,
    action: Schema.Literals(["continue", "stop"]),
    motivo: Schema.optional(Schema.String),
    n: Schema.Number,
  },
})

export * as SessionAuto from "./auto"
