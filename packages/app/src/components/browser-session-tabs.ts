// Session-to-tab affinity for the Desktop browser panel (pure: no Solid,
// no Electron, so bun can test it). The panel keeps one tab per conversation:
// switching sessions selects the mapped tab, assigns a spare blank tab, opens
// a new one, or — when full — evicts the least-recently-used tab.
export type SessionTabView = {
  id: string
  touched: boolean
  lastUsed: number
}

export type SessionTabDecision =
  | { action: "none" }
  | { action: "select"; tabId: string }
  | { action: "assign"; tabId: string }
  | { action: "create" }
  | { action: "evict"; tabId: string }

export function chooseSessionTab(input: {
  sessionID: string | undefined
  tabs: SessionTabView[]
  sessionTabs: Record<string, string>
  maxTabs: number
}): SessionTabDecision {
  if (!input.sessionID) return { action: "none" }
  const mapped = input.sessionTabs[input.sessionID]
  if (mapped && input.tabs.some((tab) => tab.id === mapped)) return { action: "select", tabId: mapped }
  const spare = input.tabs.find((tab) => !tab.touched)
  if (spare) return { action: "assign", tabId: spare.id }
  if (input.tabs.length < input.maxTabs) return { action: "create" }
  if (input.tabs.length === 0) return { action: "create" }
  let victim = input.tabs[0]
  for (const tab of input.tabs) {
    if (tab.lastUsed < victim.lastUsed) victim = tab
  }
  return { action: "evict", tabId: victim.id }
}

/** Storage key for the session -> tab affinity map. */
export const SESSION_TABS_KEY = "sessionTabs"

/** Bounds the affinity map; sessions beyond this get a fresh tab each visit. */
export const MAX_SESSION_TABS = 50

/** Per-session last URL, so a returning conversation restores its own page. */
export const sessionUrlKey = (sessionID: string) => `sessionUrl-${sessionID}`

/** Mirrors main's tab id shape (desktop browser-tabs.ts isValidTabId). */
const TAB_ID_PATTERN = /^t[1-9]\d*$/

/** Parses the persisted affinity map, dropping anything malformed. */
export function parseSessionTabs(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const next: Record<string, string> = {}
  for (const [sessionID, tabId] of Object.entries(parsed)) {
    if (typeof tabId === "string" && TAB_ID_PATTERN.test(tabId)) next[sessionID] = tabId
  }
  return next
}

/**
 * Records session -> tab, stealing the tab from any other session pointing at
 * it (one tab shows one conversation) and trimming the oldest entries at the
 * cap. Returns the new map; the caller persists it.
 */
export function recordSessionTab(
  sessionTabs: Record<string, string>,
  sessionID: string,
  tabId: string,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [other, otherTab] of Object.entries(sessionTabs)) {
    if (otherTab !== tabId) next[other] = otherTab
  }
  next[sessionID] = tabId
  const keys = Object.keys(next)
  if (keys.length <= MAX_SESSION_TABS) return next
  const trimmed: Record<string, string> = {}
  for (const key of keys.slice(-MAX_SESSION_TABS)) trimmed[key] = next[key]
  return trimmed
}

/** Forgets every session pointing at a closed tab. */
export function dropTabSessions(sessionTabs: Record<string, string>, tabId: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [sessionID, mapped] of Object.entries(sessionTabs)) {
    if (mapped !== tabId) next[sessionID] = mapped
  }
  return next
}

/** Which session owns a tab, if any. */
export function sessionForTab(sessionTabs: Record<string, string>, tabId: string): string | undefined {
  for (const [sessionID, mapped] of Object.entries(sessionTabs)) {
    if (mapped === tabId) return sessionID
  }
  return undefined
}

/** First free tN id in 1..maxTabs, so closed ids (and their wiped jars) recycle. */
export function firstFreeTabId(existing: string[], maxTabs: number): string | undefined {
  for (let n = 1; n <= maxTabs; n += 1) {
    const id = `t${n}`
    if (!existing.includes(id)) return id
  }
  return undefined
}
