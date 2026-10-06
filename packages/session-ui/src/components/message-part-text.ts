export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

export type EstadoState = "COMPLETO" | "BLOQUEADO" | "SIGUE"

// Same line protocol the backend parses in SessionAuto.parseEstado
// (packages/opencode/src/session/auto.ts): an agent running with
// auto-continue closes its turn with ESTADO: <state>[: <detail>].
// The chat splits that line out of the markdown body and renders it
// as a status tag so it does not get lost inside long answers.
const estadoLine = /^ESTADO:\s*(COMPLETO|BLOQUEADO|SIGUE)(?::\s*(.+))?\s*$/m

export function splitEstadoLine(text: string): {
  body: string
  estado?: { state: EstadoState; detail?: string }
} {
  const match = estadoLine.exec(text)
  if (!match) return { body: text }
  const state = match[1] as EstadoState
  const detail = match[2]?.trim() || undefined
  const body = text
    .split("\n")
    .filter((line) => line !== match[0])
    .join("\n")
    .trim()
  return { body, estado: { state, detail } }
}

export type AutoOrder = "continuar" | "terminar"

// Same channel the backend writes in SessionPrompt (packages/opencode/src/
// session/prompt.ts): steers (`[Auto n/N] <instruction>`, metadata
// auto:"steer") keep the loop going, stop decisions (`[Auto n/N] Decisión:
// terminar — <motivo>`, metadata auto:"decision") record why it ended.
// Both are synthetic user messages; the chat renders them as a card with
// the order + exact instruction instead of an empty bubble.
const autoHead = /^\[Auto (\d+\/\d+)\]\s*([\s\S]*)$/
const decisionLead = /^Decisión:\s*terminar\s*[—–-]\s*/i

export function autoCardOf(part: { synthetic?: boolean; metadata?: unknown; text?: string }): {
  order: AutoOrder
  head: string
  body: string
} | undefined {
  if (!part.synthetic || typeof part.text !== "string") return undefined
  if (typeof part.metadata !== "object" || part.metadata === null) return undefined
  if (!("auto" in part.metadata)) return undefined
  const kind = part.metadata.auto
  if (kind !== "steer" && kind !== "decision") return undefined
  const match = autoHead.exec(part.text.trim())
  if (!match) return undefined
  const order: AutoOrder = kind === "decision" ? "terminar" : "continuar"
  const rest = (match[2] ?? "").trim()
  return {
    order,
    head: match[1]!,
    body: order === "terminar" ? rest.replace(decisionLead, "") : rest,
  }
}
