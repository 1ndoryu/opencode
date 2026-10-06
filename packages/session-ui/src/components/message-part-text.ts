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
