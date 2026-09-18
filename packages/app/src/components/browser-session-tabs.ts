// Per-conversation tab strips for the Desktop browser panel (pure: no Solid,
// no Electron, so bun can test it). Each conversation owns its own strip —
// an ordered tab list plus the selected tab — over the shared global t1..t8
// pool (one webview/partition per id in main). Switching sessions swaps the
// visible strip; guests stay mounted in the background, so pages survive.
// A tab id belongs to exactly one strip; ids listed by any strip are never
// handed to another session.
export type SessionTabView = {
  id: string
  touched: boolean
  lastUsed: number
}

export type SessionStrip = {
  tabs: string[]
  selected: string
}

export type StripDecision =
  | { action: "none" }
  | { action: "select"; tabId: string }
  | { action: "adopt"; tabId: string }
  | { action: "create" }
  | { action: "evict"; tabId: string }

export function chooseStrip(input: {
  sessionID: string | undefined
  live: SessionTabView[]
  strips: Record<string, SessionStrip>
  maxTabs: number
}): StripDecision {
  if (!input.sessionID) return { action: "none" }
  const strip = input.strips[input.sessionID]
  if (strip) {
    const liveIds = new Set(input.live.map((tab) => tab.id))
    if (strip.selected && liveIds.has(strip.selected)) return { action: "select", tabId: strip.selected }
    // After a reload the webviews are gone but the strip still lists them:
    // pick a surviving tab and let the caller remount the rest.
    const known = strip.tabs.find((id) => liveIds.has(id))
    if (known) return { action: "select", tabId: known }
    // OP-25/R0a (I6): the persisted strip still owns tabs, just none is
    // mounted (touched={} after a restart). Hand it back so the caller
    // remounts its own pages (mountStripTabs runs on select) instead of
    // adopting a stranger's spare and overwriting the strip with it.
    if (strip.tabs.length > 0) {
      const persisted = strip.tabs.includes(strip.selected) ? strip.selected : strip.tabs[0]
      return { action: "select", tabId: persisted }
    }
  }
  const owned = new Set<string>()
  for (const other of Object.values(input.strips)) for (const id of other.tabs) owned.add(id)
  // An adoptable tab is blank and owned by nobody: on a fresh mount every tab
  // is untouched, and handing another session's tab over would steal its page.
  const spare = input.live.find((tab) => !tab.touched && !owned.has(tab.id))
  if (spare) return { action: "adopt", tabId: spare.id }
  const reserved = new Set(owned)
  for (const tab of input.live) reserved.add(tab.id)
  for (let n = 1; n <= input.maxTabs; n += 1) {
    if (!reserved.has(`t${n}`)) return { action: "create" }
  }
  // The pool is hogged (live plus ids reserved by strips): recycle the
  // least-recently-used live tab, preferring one no strip owns so other
  // conversations keep their strips. With no live tab the caller resets.
  if (input.live.length === 0) return { action: "create" }
  const unowned = input.live.filter((tab) => !owned.has(tab.id))
  const pool = unowned.length > 0 ? unowned : input.live
  let victim = pool[0]
  for (const tab of pool) {
    if (tab.lastUsed < victim.lastUsed) victim = tab
  }
  return { action: "evict", tabId: victim.id }
}

/** Storage key for the session -> strip map. */
export const SESSION_STRIPS_KEY = "sessionStrips"

/** Legacy affinity key (session -> single tab); migrated once, then dropped. */
export const LEGACY_SESSION_TABS_KEY = "sessionTabs"

/** Bounds the strip map; sessions beyond this start fresh each visit. */
export const MAX_SESSION_STRIPS = 50

/** Per-session last URL, so a returning conversation restores its own page. */
export const sessionUrlKey = (sessionID: string) => `sessionUrl-${sessionID}`

/** Per (session, tab) page: each strip tab remembers its own page. */
export const stripUrlKey = (sessionID: string, tabId: string) => `sessionTabUrl-${sessionID}-${tabId}`

/** Mirrors main's tab id shape (desktop browser-tabs.ts isValidTabId). */
const TAB_ID_PATTERN = /^t[1-9]\d*$/

const isStrip = (value: unknown): value is SessionStrip => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const strip = value as Record<string, unknown>
  return (
    Array.isArray(strip.tabs) &&
    strip.tabs.every((id) => typeof id === "string" && TAB_ID_PATTERN.test(id)) &&
    typeof strip.selected === "string"
  )
}

/** Parses the persisted strip map, dropping anything malformed. */
export function parseSessionStrips(raw: unknown): Record<string, SessionStrip> {
  if (typeof raw !== "string" || !raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const next: Record<string, SessionStrip> = {}
  for (const [sessionID, strip] of Object.entries(parsed)) {
    if (isStrip(strip) && strip.tabs.length > 0) next[sessionID] = { tabs: [...strip.tabs], selected: strip.selected }
  }
  return next
}

/**
 * Parses the legacy session -> tab map (OP-13 single-tab affinity) for the
 * one-time migration into strips.
 */
export function parseLegacySessionTabs(raw: unknown): Record<string, string> {
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
 * Migrates the legacy session -> tab map (OP-13) into single-tab strips.
 * Sessions sharing one tab keep it each; use converges back to one owner.
 */
export function migrateLegacyStrips(legacy: Record<string, string>): Record<string, SessionStrip> {
  const next: Record<string, SessionStrip> = {}
  for (const [sessionID, tabId] of Object.entries(legacy)) {
    if (typeof tabId === "string" && TAB_ID_PATTERN.test(tabId)) next[sessionID] = { tabs: [tabId], selected: tabId }
  }
  return next
}

/**
 * Records a session's strip and trims the oldest entries at the cap.
 * Fail-closed since OP-25/R0a (I1): a tab id belongs to exactly one strip,
 * so recording ids owned by another strip refuses the whole write and leaves
 * every strip untouched — a focus on a foreign tab (selectTab -> claimTab)
 * can never destroy its owner's strip. Matches the recordAgentTab guard
 * below. Legitimate adopt/create paths use fresh ids (firstFreeTabId over
 * reservedStripIds) so they never overlap. Returns the new map; the caller
 * persists it.
 */
export function recordStrip(
  strips: Record<string, SessionStrip>,
  sessionID: string,
  strip: SessionStrip,
): Record<string, SessionStrip> {
  for (const id of strip.tabs) {
    const owner = sessionForTab(strips, id)
    if (owner && owner !== sessionID) return strips
  }
  const ids = new Set(strip.tabs)
  const next: Record<string, SessionStrip> = {}
  for (const [other, otherStrip] of Object.entries(strips)) {
    if (other === sessionID) continue
    const kept = otherStrip.tabs.filter((id) => !ids.has(id))
    if (kept.length > 0)
      next[other] = { tabs: kept, selected: kept.includes(otherStrip.selected) ? otherStrip.selected : kept[0] }
  }
  next[sessionID] = { tabs: [...new Set(strip.tabs)], selected: strip.selected }
  const keys = Object.keys(next)
  if (keys.length <= MAX_SESSION_STRIPS) return next
  const trimmed: Record<string, SessionStrip> = {}
  for (const key of keys.slice(-MAX_SESSION_STRIPS)) trimmed[key] = next[key]
  return trimmed
}

/** Forgets a closed tab everywhere; strips left empty are deleted. */
export function dropStripTab(strips: Record<string, SessionStrip>, tabId: string): Record<string, SessionStrip> {
  const next: Record<string, SessionStrip> = {}
  for (const [sessionID, strip] of Object.entries(strips)) {
    const kept = strip.tabs.filter((id) => id !== tabId)
    if (kept.length > 0)
      next[sessionID] = { tabs: kept, selected: kept.includes(strip.selected) ? strip.selected : kept[0] }
  }
  return next
}

/** Which session shows a tab, if any. */
export function sessionForTab(strips: Record<string, SessionStrip>, tabId: string): string | undefined {
  for (const [sessionID, strip] of Object.entries(strips)) {
    if (strip.tabs.includes(tabId)) return sessionID
  }
  return undefined
}

/**
 * Whether an agent-driven tab select may move the visible panel. The agent
 * acts per session while the user views one conversation: following a tab
 * owned by another session would paint its page over the viewed one (and
 * two agents would ping-pong the panel), so only the viewed session's own
 * tabs move the selection.
 *
 * Fail-closed since OP-25/R0a (I7): an unknown owner, an unknown viewed
 * session, or an acting session without a viewed session follows NOTHING.
 * Every borrowed / post-restart tab is ownerless, so following it would leak
 * one conversation's page into every other view (L3/L4).
 *
 * OP-23: when main reports which session acted, that alone decides — only
 * the acting session's own view follows.
 */
export function shouldFollowAgentTab(input: {
  tabId: string
  strips: Record<string, SessionStrip>
  viewedSessionID: string | undefined
  agentSessionID?: string
}): boolean {
  if (input.agentSessionID) {
    if (!input.viewedSessionID) return false
    return input.agentSessionID === input.viewedSessionID
  }
  const owner = sessionForTab(input.strips, input.tabId)
  if (!owner || !input.viewedSessionID) return false
  return owner === input.viewedSessionID
}

/**
 * Records an agent-touched tab in the acting session's strip (OP-23). The
 * agent never claims through the viewed session, so without this its tab
 * stays ownerless: followed everywhere and adoptable by any session. Never
 * steals a tab owned by another strip — a tab main picked from elsewhere
 * stays put (the caller ignores the select instead).
 */
export function recordAgentTab(
  strips: Record<string, SessionStrip>,
  sessionID: string | undefined,
  tabId: string,
): Record<string, SessionStrip> {
  if (!sessionID || !TAB_ID_PATTERN.test(tabId)) return strips
  const owner = sessionForTab(strips, tabId)
  if (owner && owner !== sessionID) return strips
  const current = strips[sessionID]
  const tabs = current ? (current.tabs.includes(tabId) ? current.tabs : [...current.tabs, tabId]) : [tabId]
  return recordStrip(strips, sessionID, { tabs, selected: tabId })
}

/** Every id no other session may take: live tabs plus all listed ids. */
export function reservedStripIds(live: string[], strips: Record<string, SessionStrip>): string[] {
  const reserved = new Set(live)
  for (const strip of Object.values(strips)) for (const id of strip.tabs) reserved.add(id)
  return [...reserved]
}

/** First free tN id in 1..maxTabs, so closed ids (and their wiped jars) recycle. */
export function firstFreeTabId(existing: string[], maxTabs: number): string | undefined {
  for (let n = 1; n <= maxTabs; n += 1) {
    const id = `t${n}`
    if (!existing.includes(id)) return id
  }
  return undefined
}

/**
 * Restore decision for a selected blank tab (OP-25/R0b seam). Pure so the
 * matrix in the test file pins it: restore only when the webview is
 * attached, still blank, still the visible selection, and a stored page was
 * resolved. restoreSessionPage re-checks through this seam AFTER the async
 * storage read (attach/dispose race, L7); its cheap pre-fetch gate mirrors
 * the same conditions minus the stored url to skip useless reads. This seam
 * models the selected-restore only — attachGuest's in-place background
 * restore deliberately has no selection check and must not use it.
 */
export function shouldRestore(input: {
  attached: boolean
  isBlank: boolean
  isSelected: boolean
  storedUrl: string | undefined
}): boolean {
  if (!input.attached) return false
  if (!input.isBlank) return false
  if (!input.isSelected) return false
  if (!input.storedUrl) return false
  return true
}
