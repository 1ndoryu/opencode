import type { AutoPolicyState, AutoVerdict } from "./auto-contract"
// Read-only verdict panel (OP-38 F1b). Fixed templates keyed by verdict,
// no free-text slots: tool names pass an allowlist, everything else is
// dropped by the two redaction layers. Never renders system prompt or CoT.
export interface PanelVerdict {
  headlineKey: string
  reasonKey: string
  tools: string[]
}

const TOOL_ALLOWLIST = new Set([
  "read",
  "edit",
  "write",
  "bash",
  "glob",
  "grep",
  "test",
  "typecheck",
  "question",
  "todowrite",
])

function stripLayer(raw: string): string {
  return raw
    .replace(/`[^`]*`/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted]")
    .replace(/(^|\s)(\/|[a-zA-Z]:[\\/]|\.{0,2}\/)[\w.~/-]+/g, "$1[redacted]")
    .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "[redacted]")
}

function allowlistTools(names: string[]): string[] {
  const kept: string[] = []
  for (const name of names) {
    const clean = stripLayer(name).trim().toLowerCase()
    if (TOOL_ALLOWLIST.has(clean) && !kept.includes(clean)) kept.push(clean)
  }
  return kept
}

const HEADLINE_KEYS: Record<AutoVerdict, string> = {
  CONTINUE: "auto.verdict.continue",
  ASK_USER: "auto.verdict.ask-user",
  SUMMARIZE: "auto.verdict.summarize",
  STOP: "auto.verdict.stop",
}

export function renderPanelVerdict(state: AutoPolicyState, toolNames: string[]): PanelVerdict {
  return {
    headlineKey: HEADLINE_KEYS[state.verdict],
    reasonKey: state.reasonKey,
    tools: allowlistTools(toolNames),
  }
}
