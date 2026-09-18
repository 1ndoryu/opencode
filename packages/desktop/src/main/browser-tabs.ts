// Pure tab bookkeeping for the Desktop browser panel (no Electron imports
// so bun can test it). Tabs isolate conversations: each tab gets its own
// persist partition (separate cookie jars) and agent sessions pin to the tab
// they first touched, so conversation B never clobbers conversation A's page.

/** Max visible tabs per window. Bounds one renderer process per webview. */
export const MAX_TABS = 8

/** Base partition keeps working for the single-tab panel. */
export const BROWSER_PARTITION_BASE = "persist:propio-browser"

/** Max pinned sessions remembered. Pins are tiny; the bound stops slow growth. */
const MAX_PINS = 500

/** Renderer-owned tab ids: t1, t2, ... (short, partition-safe). */
export function isValidTabId(tabId: unknown): tabId is string {
  return typeof tabId === "string" && tabId.length <= 8 && /^t[1-9]\d*$/.test(tabId)
}

/** Sidecar-provided session ids (UUIDs). Validated so the pins map stays clean. */
export function isValidSessionID(sessionID: unknown): sessionID is string {
  return typeof sessionID === "string" && sessionID.length >= 1 && sessionID.length <= 128
}

/** Registry key: tab ids repeat across windows, host ids do not. */
export function tabKey(hostId: number, tabId: string): string {
  return `${hostId}:${tabId}`
}

/** Per-tab persist partition: separate cookie jar per conversation. */
export function partitionForTab(tabId: string): string {
  return `${BROWSER_PARTITION_BASE}-${tabId}`
}

/** will-attach-webview allowlist: base partition plus per-tab partitions. */
export function isAllowedPartition(partition: unknown): boolean {
  if (partition === BROWSER_PARTITION_BASE) return true
  if (typeof partition !== "string") return false
  const rest = partition.slice(BROWSER_PARTITION_BASE.length + 1)
  return partition.startsWith(`${BROWSER_PARTITION_BASE}-`) && isValidTabId(rest)
}

/** sessionID -> tabKey, insertion-ordered so the oldest drops first at the cap. */
export function pinSession(pins: Map<string, string>, sessionID: string, key: string): void {
  pins.delete(sessionID)
  pins.set(sessionID, key)
  while (pins.size > MAX_PINS) {
    const oldest = pins.keys().next()
    if (oldest.done) return
    pins.delete(oldest.value)
  }
}

/** Pinned tabKey for a session, only when the caller confirms it is still alive. */
export function pinnedKey(
  pins: Map<string, string>,
  sessionID: string | undefined,
  alive: (key: string) => boolean,
): string | undefined {
  if (!isValidSessionID(sessionID)) return undefined
  const key = pins.get(sessionID)
  if (!key) return undefined
  if (alive(key)) return key
  pins.delete(sessionID)
  return undefined
}

/**
 * Agent tab choice within one window (OP-23, fail-closed since OP-25/R0a):
 * the caller resolves the explicit tab and the session pin first. Here the
 * agent session owns nothing live, so keep the visible tab when nobody else
 * pinned it, otherwise take the first tab no other session pinned. With no
 * unpinned candidate there is nothing to take: return undefined and let the
 * caller surface NO_AGENT_TAB (R1) instead of borrowing a foreign tab (L2).
 */
export function chooseAgentTabId(input: {
  tabIds: string[]
  selectedTabId: string | undefined
  otherPinnedTabIds: Set<string> | readonly string[]
}): string | undefined {
  if (input.tabIds.length === 0) return undefined
  const other =
    input.otherPinnedTabIds instanceof Set ? input.otherPinnedTabIds : new Set(input.otherPinnedTabIds)
  const selectedLive =
    input.selectedTabId && input.tabIds.includes(input.selectedTabId) ? input.selectedTabId : undefined
  if (selectedLive && !other.has(selectedLive)) return selectedLive
  const unpinned = input.tabIds.find((id) => !other.has(id))
  if (unpinned) return unpinned
  return undefined
}

/**
 * Typed agent failure (OP-25/R1, I3 contract): the browser has attached
 * pages but none may serve this session — every candidate is pinned to
 * another conversation and borrowing is forbidden. The message carries the
 * recovery (claim a tab from the conversation's own Navegador panel, or
 * target one explicitly) so the agent can act instead of retrying blind.
 */
export class NoAgentTabError extends Error {
  readonly code = "NO_AGENT_TAB"
  constructor(readonly sessionID: string | undefined) {
    super(
      sessionID === undefined
        ? "No browser tab is available to the agent (NO_AGENT_TAB) — every open page is pinned to another conversation. Open the Navegador tab in the acting conversation first, or pass an explicit tabId from browser_state output, then retry."
        : `No browser tab belongs to session ${sessionID} (NO_AGENT_TAB) — every open page is pinned to another conversation. Open the Navegador tab in THIS conversation first (it claims a tab for the session), or pass an explicit tabId from browser_state output, then retry.`,
    )
    this.name = "NoAgentTabError"
  }
}
