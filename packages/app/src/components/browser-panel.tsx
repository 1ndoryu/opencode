import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type BrowserPanelState, type BrowserPickResult } from "@/context/platform"
import { useBrowserHost } from "@/context/browser-host"
import { showToast } from "@/utils/toast"
import {
  chooseEvictVictim,
  chooseStrip,
  dropStripTab,
  firstFreeTabId,
  LEGACY_SESSION_TABS_KEY,
  migrateLegacyStrips,
  parseLegacySessionTabs,
  parseSessionStrips,
  recordAgentTab,
  recordStrip,
  reservedStripIds,
  SESSION_STRIPS_KEY,
  sessionForTab,
  sessionUrlKey,
  shouldFollowAgentTab,
  shouldRestore,
  stripUrlKey,
  type SessionStrip,
} from "./browser-session-tabs"
import { BrowserPanelTabs } from "./browser-panel-tabs"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "./titlebar-session-events"
import "./browser-panel.css"

// Mirrors main's partitionForTab (desktop browser-tabs.ts): one persist
// partition per tab, so each conversation gets its own cookie jar. Main
// validates the partition in will-attach-webview; anything else refuses to attach.
const BROWSER_PARTITION_BASE = "persist:propio-browser"
const partitionForTab = (tabId: string) => `${BROWSER_PARTITION_BASE}-${tabId}`
// Mirrors main's MAX_TABS: the panel never creates more webviews than main tracks.
const MAX_TABS = 8
const BROWSER_STORAGE = "opencode.browser.dat"
const LAST_URL_KEY = "lastUrl"
const BLANK_URL = "about:blank"

/** Electron extends the guest element with guest APIs at runtime. */
type BrowserWebviewElement = HTMLElement & {
  getWebContentsId(): number
}

type BrowserTab = {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  attached: boolean
}

const blankTab = (id: string): BrowserTab => ({
  id,
  title: "",
  url: BLANK_URL,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  attached: false,
})

export function BrowserPanel(props: { onClose?: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const host = useBrowserHost()
  // The panel lives in the app shell; the active session page publishes which
  // conversation it serves, so switches never unmount the webviews.
  const activeSessionID = () => host.frame()?.sessionID
  const browser = () => platform.browser
  const [state, setState] = createStore({
    input: BLANK_URL,
    editing: false,
    picking: false,
    tabs: [blankTab("t1")],
    selectedId: "t1",
    // sessionID -> strip: each conversation owns its own tab strip (ordered
    // tab ids plus the selected one) over the shared t1..t8 pool. Persisted
    // and validated on load; a tab id belongs to exactly one strip.
    strips: {} as Record<string, SessionStrip>,
    stripsLoaded: false,
    // Mount load finished: before this the panel cannot know whether the
    // viewed conversation has a strip (loading) vs has none (empty). Both
    // render no tabs with a disabled toolbar — never the global selected.
    // Tabs with a real page (user or agent navigated). Untouched blanks are
    // free for newly seen sessions; full + all touched evicts LRU.
    touched: {} as Record<string, boolean>,
    lastUsed: {} as Record<string, number>,
  })

  const selected = () => state.tabs.find((tab) => tab.id === state.selectedId) ?? state.tabs[0]
  const tabIndex = (tabId: string) => state.tabs.findIndex((tab) => tab.id === tabId)
  // t1 keeps the legacy key so the stored URL survives the tabs upgrade.
  const lastUrlKey = (tabId: string) => (tabId === "t1" ? LAST_URL_KEY : `${LAST_URL_KEY}-${tabId}`)

  const apply = (tabId: string, next: BrowserPanelState) => {
    const index = tabIndex(tabId)
    if (index < 0) return
    setState("tabs", index, {
      url: next.url,
      title: next.title,
      loading: next.loading,
      canGoBack: next.canGoBack,
      canGoForward: next.canGoForward,
    })
    if (next.url && next.url !== BLANK_URL) {
      setState("touched", tabId, true)
      setState("lastUsed", tabId, Date.now())
      // Every real page counts, not just toolbar navigations: agent moves,
      // link clicks and back/forward arrive here via onState, and the owning
      // session must restore them after a switch. Ownerless tabs (fresh,
      // agent-only before any claim) are skipped, never misattributed.
      rememberSessionPage(tabId, next.url)
    }
    if (tabId === state.selectedId && !state.editing) setState("input", next.url)
  }

  // Toolbar actions run against the selected tab server-side; the captured
  // tabId routes the result back even if selection moved mid-request.
  const runOnSelected = (run: (target: NonNullable<ReturnType<typeof browser>>) => Promise<BrowserPanelState>) => {
    const target = browser()
    const tabId = state.selectedId
    if (!target) return
    run(target).then((next) => apply(tabId, next))
  }

  const persistStrips = (next: Record<string, SessionStrip>, pruneKeys: string[] = []) => {
    setState("strips", next)
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return
    void Promise.resolve(store.setItem(SESSION_STRIPS_KEY, JSON.stringify(next))).catch(() => undefined)
    // A session page survives evictions (the session restores it into its
    // next tab); only an explicit tab close drops those pages.
    for (const key of pruneKeys) void Promise.resolve(store.removeItem(key)).catch(() => undefined)
  }

  // Persisted strips, read fresh: state may still hold the initial empty map
  // while the mount load is in flight (attach restores race with it). The
  // OP-13 single-tab map migrates once, then its key is dropped.
  const loadStrips = async (): Promise<Record<string, SessionStrip>> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return {}
    try {
      const raw = await store.getItem(SESSION_STRIPS_KEY)
      if (raw) return parseSessionStrips(raw)
      const migrated = migrateLegacyStrips(parseLegacySessionTabs(await store.getItem(LEGACY_SESSION_TABS_KEY)))
      void Promise.resolve(store.setItem(SESSION_STRIPS_KEY, JSON.stringify(migrated))).catch(() => undefined)
      void Promise.resolve(store.removeItem(LEGACY_SESSION_TABS_KEY)).catch(() => undefined)
      return migrated
    } catch {
      return {}
    }
  }

  // The active conversation claims this tab: the strip selects it and main
  // pins session -> tab so the agent defaults to the page the user sees.
  // Stale ids (listed but without a webview, e.g. after reload) are pruned,
  // and dead ids are never listed (I1: only live tabs belong to a strip).
  const claimTab = (tabId: string) => {
    const sessionID = activeSessionID()
    if (!sessionID) return
    const liveIds = new Set(state.tabs.map((tab) => tab.id))
    if (!liveIds.has(tabId)) return
    const kept = (state.strips[sessionID]?.tabs ?? []).filter((id) => liveIds.has(id))
    const tabs = kept.includes(tabId) ? kept : [...kept, tabId]
    persistStrips(recordStrip(state.strips, sessionID, { tabs, selected: tabId }))
    const target = browser()
    if (!target) return
    void target.pinSession(sessionID, tabId).catch(() => undefined)
  }

  const focusTab = (tabId: string) => {
    if (tabIndex(tabId) < 0) return
    setState("selectedId", tabId)
    setState("lastUsed", tabId, Date.now())
    const tab = selected()
    if (tab && !state.editing) setState("input", tab.url)
    const target = browser()
    if (!target) return
    void target.selectTab(tabId).catch(() => undefined)
  }

  const readSessionUrl = async (sessionID: string): Promise<string | undefined> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return undefined
    try {
      return (await store.getItem(sessionUrlKey(sessionID))) ?? undefined
    } catch {
      return undefined
    }
  }

  // Remembers the owner's page per (session, tab) from any source (toolbar,
  // agent, links, back/forward): apply() sees them all via onState. Restore
  // navigations rewrite the same URL, so this stays idempotent.
  const rememberSessionPage = (tabId: string, url: string) => {
    const owner = sessionForTab(state.strips, tabId)
    if (!owner) return
    void Promise.resolve(platform.storage?.(BROWSER_STORAGE).setItem(stripUrlKey(owner, tabId), url)).catch(
      () => undefined,
    )
  }

  const readStripUrl = async (sessionID: string, tabId: string): Promise<string | undefined> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return undefined
    try {
      return (await store.getItem(stripUrlKey(sessionID, tabId))) ?? undefined
    } catch {
      return undefined
    }
  }

  // A tab that stayed blank (fresh mount, adopted spare) shows its own page
  // as soon as it is known; the legacy per-session key covers OP-13 profiles.
  const restoreSessionPage = (sessionID: string, tabId: string) => {
    const index = tabIndex(tabId)
    if (index < 0 || !state.tabs[index].attached || state.tabs[index].url !== BLANK_URL) return
    void readStripUrl(sessionID, tabId)
      .then((stripUrl) => stripUrl ?? readSessionUrl(sessionID))
      .then((url) => {
        if (!url) return
        const current = tabIndex(tabId)
        if (current < 0) return
        const tab = state.tabs[current]
        if (
          !shouldRestore({
            attached: tab.attached,
            isBlank: tab.url === BLANK_URL,
            isSelected: state.selectedId === tabId,
            storedUrl: url,
          })
        )
          return
        go(url)
      })
      .catch(() => undefined)
  }

  // Frees one pool slot keeping the given ids (I9 pool policy, single
  // implementation in chooseEvictVictim). Pages survive: eviction never
  // prunes session URLs.
  const freeSlot = (keep: string[]): boolean => {
    if (state.tabs.length < MAX_TABS) return true
    const owned: string[] = []
    for (const ownerStrip of Object.values(state.strips)) owned.push(...ownerStrip.tabs)
    const victim = chooseEvictVictim(
      state.tabs.map((tab) => ({ id: tab.id, lastUsed: state.lastUsed[tab.id] ?? 0 })),
      owned,
      keep,
    )
    if (!victim) return false
    closeTabInternal(victim, false)
    return true
  }

  // Remounts the strip's tabs missing a webview (e.g. after a reload); each
  // attach restores its own page on dom-ready via restoreUrlFor.
  const mountStripTabs = (sessionID: string) => {
    const strip = state.strips[sessionID]
    if (!strip) return
    for (const id of strip.tabs) {
      if (tabIndex(id) >= 0) continue
      if (!freeSlot(strip.tabs)) return
      setState("tabs", (tabs) => [...tabs, blankTab(id)])
    }
  }

  // Switching conversations swaps to that conversation's own strip (or finds
  // it a home), so tabs never leak across sessions. Guests of other strips
  // stay mounted in the background with their pages intact.
  const ensureSessionStrip = (sessionID: string) => {
    const live = state.tabs.map((tab) => ({
      id: tab.id,
      touched: state.touched[tab.id] ?? false,
      lastUsed: state.lastUsed[tab.id] ?? 0,
    }))
    const decision = chooseStrip({ sessionID, live, strips: state.strips, maxTabs: MAX_TABS })
    if (decision.action === "none") return
    if (decision.action === "select") {
      mountStripTabs(sessionID)
      // After a remount the strip's selected tab is back: prefer it.
      const after = state.strips[sessionID]
      const id = after && tabIndex(after.selected) >= 0 ? after.selected : decision.tabId
      focusTab(id)
      claimTab(id)
      restoreSessionPage(sessionID, id)
      return
    }
    if (decision.action === "adopt") {
      persistStrips(recordStrip(state.strips, sessionID, { tabs: [decision.tabId], selected: decision.tabId }))
      focusTab(decision.tabId)
      claimTab(decision.tabId)
      restoreSessionPage(sessionID, decision.tabId)
      return
    }
    if (decision.action === "create") {
      const id = firstFreeTabId(reservedStripIds(live.map((tab) => tab.id), state.strips), MAX_TABS)
      if (!id) return
      setState("tabs", (tabs) => [...tabs, blankTab(id)])
      focusTab(id)
      claimTab(id)
      // Fresh webview: attachGuest restores the session URL on dom-ready.
      return
    }
    // Evict: closeTabInternal wipes the victim's jar in main, so the recycled
    // id starts clean; the victim keeps its session URLs and restores them
    // into its next tab. The new webview restores this session's URL on attach.
    closeTabInternal(decision.tabId, false)
    const id = firstFreeTabId(reservedStripIds(state.tabs.map((tab) => tab.id), state.strips), MAX_TABS)
    if (!id) return
    setState("tabs", (tabs) => [...tabs, blankTab(id)])
    focusTab(id)
    claimTab(id)
  }

  const go = (raw: string) => {
    const target = browser()
    const value = raw.trim()
    // Without a live selected tab there is nothing to drive: navigating
    // would only pollute touched/claims/page keys with a dead id.
    if (!target || !selected() || !value) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setState("input", url)
    setState("touched", state.selectedId, true)
    setState("lastUsed", state.selectedId, Date.now())
    // Navigating claims the tab for this conversation and remembers the page
    // per session, so switching away and back restores it.
    claimTab(state.selectedId)
    runOnSelected((selected) => selected.navigate(url))
    // lastUrl-* stays a read-only legacy upgrade path (restoreUrlFor, empty
    // map only): new navigations persist per (session, tab) only.
    const sessionID = activeSessionID()
    if (sessionID) void platform.storage?.(BROWSER_STORAGE).setItem(stripUrlKey(sessionID, state.selectedId), url)
  }

  const selectTab = (tabId: string) => {
    // Manual selection stays inside this conversation's strip: focusing a
    // foreign tab would paint another session's page here.
    if (!currentStrip()?.tabs.includes(tabId)) return
    focusTab(tabId)
    // Manual selection moves the conversation here too.
    claimTab(tabId)
  }

  const addTabInternal = (exclude: string[] = []) => {
    const id = firstFreeTabId([...state.tabs.map((tab) => tab.id), ...exclude], MAX_TABS)
    if (!id) return undefined
    setState("tabs", (tabs) => [...tabs, blankTab(id)])
    focusTab(id)
    return id
  }

  // New tabs join this conversation's strip; ids listed by other strips are
  // never reused, so + never steals another conversation's tab. Without a
  // ready strip the tab would be ownerless (L3), so + stays hidden. With a
  // full pool + frees a slot with the switch policy (unowned-first LRU)
  // instead of hiding (I9: pool visible).
  const addTab = () => {
    if (!stripReady()) return
    const sessionID = activeSessionID()
    const others = Object.entries(state.strips)
      .filter(([owner]) => owner !== sessionID)
      .flatMap(([, ownerStrip]) => ownerStrip.tabs)
    let id = addTabInternal(others)
    if (!id && freeSlot([])) id = addTabInternal(others)
    if (id) claimTab(id)
  }

  const closeTabInternal = (tabId: string, pruneUrls = true) => {
    if (state.tabs.length <= 1) return
    const index = tabIndex(tabId)
    if (index < 0) return
    const target = browser()
    if (target) void target.closeTab(tabId).catch(() => undefined)
    // Only an explicit close drops page keys; evictions keep them so the
    // session restores into its next tab. Owners sharing the tab lose the id
    // but keep their other tabs; an emptied strip also drops its legacy key.
    let next = state.strips
    const pruneKeys: string[] = []
    for (const [owner, ownerStrip] of Object.entries(state.strips)) {
      if (!ownerStrip.tabs.includes(tabId)) continue
      next = dropStripTab(next, tabId)
      if (pruneUrls) {
        pruneKeys.push(stripUrlKey(owner, tabId))
        if (!next[owner]) pruneKeys.push(sessionUrlKey(owner))
      }
    }
    persistStrips(next, pruneKeys)
    const touched = { ...state.touched }
    delete touched[tabId]
    setState("touched", touched)
    const lastUsed = { ...state.lastUsed }
    delete lastUsed[tabId]
    setState("lastUsed", lastUsed)
    const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1]
    setState("tabs", (tabs) => tabs.filter((tab) => tab.id !== tabId))
    if (tabId === state.selectedId && neighbor) focusTab(neighbor.id)
  }

  const closeTab = (tabId: string) => {
    const index = tabIndex(tabId)
    if (index < 0) return
    const wasSelected = tabId === state.selectedId
    const sessionID = activeSessionID()
    // Closing the viewed strip's last tab leaves the strip empty (I9): +
    // and the address bar keep driving this conversation instead of falling
    // back to another session's tab (L1). No selection is valid then.
    const emptiesViewed =
      !!sessionID && sessionForTab(state.strips, tabId) === sessionID && currentStrip()?.tabs.length === 1
    closeTabInternal(tabId)
    if (!sessionID) return
    if (emptiesViewed) {
      persistStrips({ ...state.strips, [sessionID]: { tabs: [], selected: tabId } })
      if (wasSelected) setState("selectedId", "")
      return
    }
    // Closing the visible tab returns the conversation to its own strip,
    // never to a neighbor tab another conversation owns.
    if (wasSelected) ensureSessionStrip(sessionID)
  }

  // Deleting a conversation closes its tabs outright: main destroys the
  // webviews and wipes their jars, the strip and its page keys go with
  // them. Stale ids (listed without a webview, e.g. after reload) drop
  // without main calls.
  const closeSessionTabs = (sessionID: string) => {
    const strip = state.strips[sessionID]
    if (!strip) return
    const liveIds = new Set(state.tabs.map((tab) => tab.id))
    const stale = strip.tabs.filter((id) => !liveIds.has(id))
    let next = state.strips
    for (const id of stale) next = dropStripTab(next, id)
    if (next !== state.strips) persistStrips(next)
    const live = next[sessionID]?.tabs ?? []
    if (live.length === 0) {
      persistStrips(next, [sessionUrlKey(sessionID), ...strip.tabs.map((id) => stripUrlKey(sessionID, id))])
      return
    }
    for (const id of live) closeTabInternal(id)
    // Stale ids never reach closeTabInternal, and the legacy per-tab page
    // keys predate strips: both go with the strip keys.
    persistStrips(state.strips, [
      ...stale.map((id) => stripUrlKey(sessionID, id)),
      ...live.map((id) => lastUrlKey(id)),
    ])
    // The single last global tab can't go through closeTabInternal (it
    // refuses to leave the pool empty): destroy its webview outright and
    // drop the listing (I9: no live tab without a strip). The viewed
    // conversation's ensure below keeps the panel non-empty.
    const leftover = (state.strips[sessionID]?.tabs ?? []).filter((id) => tabIndex(id) >= 0)
    if (leftover.length > 0) {
      const target = browser()
      const gone = new Set(leftover)
      let dropped = state.strips
      const pruneKeys: string[] = []
      for (const id of leftover) {
        if (target) void target.closeTab(id).catch(() => undefined)
        dropped = dropStripTab(dropped, id)
        pruneKeys.push(stripUrlKey(sessionID, id), lastUrlKey(id))
      }
      if (!dropped[sessionID]) pruneKeys.push(sessionUrlKey(sessionID))
      setState("tabs", (tabs) => tabs.filter((tab) => !gone.has(tab.id)))
      const touched = { ...state.touched }
      const lastUsed = { ...state.lastUsed }
      for (const id of leftover) {
        delete touched[id]
        delete lastUsed[id]
      }
      setState("touched", touched)
      setState("lastUsed", lastUsed)
      if (gone.has(state.selectedId)) setState("selectedId", "")
      persistStrips(dropped, pruneKeys)
    }
    // Closing may have landed on a neighbor from another strip; return to
    // the viewed conversation's own strip. The deleted session itself is
    // skipped: navigation after removal publishes the next frame, whose
    // session-switch effect ensures its strip instead.
    const viewed = activeSessionID()
    if (viewed && viewed !== sessionID) ensureSessionStrip(viewed)
  }

  // A tab owned by a conversation restores that conversation's own page for
  // that tab. The map merges storage with state because attach restores race
  // the mount load; an unowned tab stays blank once strips exist (the legacy
  // per-tab URL only upgrades pre-strip profiles with an empty map).
  const restoreUrlFor = async (tabId: string): Promise<string | undefined> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return undefined
    const mapping = { ...(await loadStrips()), ...state.strips }
    const owner = sessionForTab(mapping, tabId)
    if (owner) return (await readStripUrl(owner, tabId)) ?? readSessionUrl(owner)
    if (Object.keys(mapping).length > 0) return undefined
    try {
      return (await store.getItem(lastUrlKey(tabId))) ?? undefined
    } catch {
      return undefined
    }
  }

  // Single source for the viewed conversation's strip: visible tabs,
  // toolbar enablement, and manual selection all derive from here, so a
  // session switch cannot mix the old strip with the new id.
  const currentStrip = () => {
    const sessionID = activeSessionID()
    return sessionID ? state.strips[sessionID] : undefined
  }

  // The toolbar and tabs only drive the viewed conversation's own strip:
  // while strips load (loading) or when it has none (empty, incl. no viewed
  // session) the panel renders no tabs and disables navigation — never the
  // global selected tab (L1/L4).
  const stripReady = () => state.stripsLoaded && currentStrip() !== undefined

  // The visible strip: this conversation's tabs only. Other strips stay
  // mounted in the background with their pages intact.
  const visibleTabs = () => {
    if (!state.stripsLoaded) return []
    const strip = currentStrip()
    if (!strip) return []
    const live = new Map(state.tabs.map((tab) => [tab.id, tab]))
    return strip.tabs.map((id) => live.get(id)).filter((tab) => tab !== undefined)
  }

  const attachGuest = (tabId: string, element: BrowserWebviewElement | undefined) => {    if (!element) return
    const api = browser()
    if (!api) return
    const guest = element
    const onReady = () => {
      api
        .attach(guest.getWebContentsId(), tabId)
        .then((current) => {
          const index = tabIndex(tabId)
          if (index >= 0) setState("tabs", index, "attached", true)
          apply(tabId, current)
          return restoreUrlFor(tabId)
        })
        .then((last) => {
          // Restores in place: no focus steal, no affinity claim. apply()
          // marks the tab touched; which tab is visible belongs to
          // ensureSessionStrip and manual selection.
          if (!last) return
          void api
            .navigate(last, tabId)
            .then((next) => apply(tabId, next))
            .catch(() => undefined)
        })
        .catch(() => undefined)
    }
    guest.addEventListener("dom-ready", onReady, { once: true })
  }

  // The panel has no prompt access in the shell; the session page publishes
  // how a picked element reaches the composer.
  const addPickedToPrompt = async (result: BrowserPickResult) => {
    await host.onPick()?.(result)
  }

  // Second press cancels the pending pick in the guest.
  const pick = async () => {
    const api = browser()
    if (!api || !selected()?.attached) return
    if (state.picking) {
      await api.cancelPick().catch(() => undefined)
      setState("picking", false)
      return
    }
    setState("picking", true)
    try {
      const result = await api.pick()
      if (!result) return
      await addPickedToPrompt(result)
      showToast({
        title: language.t("desktop.browser.pick.picked.title"),
        description: language.t("desktop.browser.pick.picked.description", { selector: result.element.selector }),
      })
    } catch {
      showToast({
        title: language.t("desktop.browser.pick.failed.title"),
        description: language.t("desktop.browser.pick.failed.description"),
      })
    } finally {
      setState("picking", false)
    }
  }

  // Mount sweep (I9): drop listed ids that are neither live nor restore
  // candidates (no URL in any schema). Stale ids with a page stay: their
  // session remounts them with their URL via mountStripTabs.
  const sweepStaleListings = async () => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return
    const live = new Set(state.tabs.map((tab) => tab.id))
    const drop: { owner: string; id: string }[] = []
    for (const [owner, ownerStrip] of Object.entries(state.strips)) {
      for (const id of ownerStrip.tabs) {
        if (live.has(id)) continue
        if (await readStripUrl(owner, id)) continue
        if (await readSessionUrl(owner)) continue
        let lastUrl: string | undefined
        try {
          lastUrl = (await store.getItem(lastUrlKey(id))) ?? undefined
        } catch {
          lastUrl = undefined
        }
        if (lastUrl) continue
        drop.push({ owner, id })
      }
    }
    if (drop.length === 0) return
    let next = state.strips
    const pruneKeys: string[] = []
    for (const { owner, id } of drop) {
      next = dropStripTab(next, id)
      pruneKeys.push(stripUrlKey(owner, id), lastUrlKey(id))
      if (!next[owner]) pruneKeys.push(sessionUrlKey(owner))
    }
    persistStrips(next, pruneKeys)
  }

  onMount(() => {
    const target = browser()
    if (!target) return
    const stopListening = target.onState((update) => {
      if (update.state) apply(update.tabId, update.state)
    })
    // The agent acting on its own session's tab flips the panel to it, so
    // the user sees what their agent is doing. A tab owned by another
    // session stays put: following it would paint that page over the
    // viewed conversation (and two agents would ping-pong the panel).
    // Agent moves don't claim affinity: main already pins that session
    // server-side. OP-23: file the tab under the acting session first, so
    // it is never ownerless (followed everywhere) nor adopted by the
    // viewed session; only the acting session's own view focuses it.
    const stopSelect = target.onSelectTab((select) => {
      // I5: the agent claim persists immediately — memory-only claims are
      // lost when another persistStrips overwrites the map.
      if (select.sessionID) persistStrips(recordAgentTab(state.strips, select.sessionID, select.tabId))
      if (
        !shouldFollowAgentTab({
          tabId: select.tabId,
          strips: state.strips,
          viewedSessionID: activeSessionID(),
          agentSessionID: select.sessionID,
        })
      ) {
        console.debug("[browser] ignoring agent tab select owned by another session", {
          tabId: select.tabId,
          sessionID: select.sessionID,
        })
        return
      }
      focusTab(select.tabId)
    })
    onCleanup(() => {
      stopListening()
      stopSelect()
      if (state.picking) void target.cancelPick().catch(() => undefined)
      for (const tab of state.tabs) void target.detach(tab.id).catch(() => undefined)
    })
    // Deletes (single or bulk, children included) close that conversation's
    // tabs with it; titlebar close only hides, never notifies. Layout hears
    // the same event for remembered tabs/view.
    makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
      const detail = readSessionTabsRemovedDetail(event)
      if (!detail) return
      for (const id of detail.sessionIDs) closeSessionTabs(id)
    })
    // Strips survive remounts; then the current conversation takes its strip.
    void (async () => {
      setState("strips", await loadStrips())
      setState("stripsLoaded", true)
      await sweepStaleListings()
      const sessionID = activeSessionID()
      if (sessionID) ensureSessionStrip(sessionID)
    })().catch(() => undefined)
  })

  // Session switches arrive as a new published frame; the panel swaps strips
  // in place and every guest stays mounted.
  createEffect(
    on(
      activeSessionID,
      (id) => {
        if (id) ensureSessionStrip(id)
      },
      { defer: true },
    ),
  )

  // OP-24: sessions with a real page in their strip, so the side panel can
  // offer and remember the browser tab per conversation. Reads only strips
  // and touched: lastUsed churn (every state update) doesn't retrigger it.
  createEffect(() => {
    const counts: Record<string, number> = {}
    for (const [owner, strip] of Object.entries(state.strips)) {
      const pages = strip.tabs.filter((id) => state.touched[id]).length
      if (pages > 0) counts[owner] = pages
    }
    host.publishBrowserPages(counts)
  })

  return (
    <Show when={browser()}>
      <section data-component="browser-panel" aria-label={language.t("desktop.browser.title")}>
        <BrowserPanelTabs
          tabs={visibleTabs()}
          selectedId={state.selectedId}
          totalCount={state.tabs.length}
          canAdd={stripReady()}
          onSelect={selectTab}
          onClose={closeTab}
          onAdd={addTab}
        />
        <div data-component="browser-panel-toolbar" class="flex items-center gap-1 px-2 py-1.5">
          <TooltipV2 value={language.t("desktop.menu.back")} placement="bottom" gutter={10}>
            <IconButton
              icon="arrow-left"
              variant="ghost"
              class="h-5 w-5"
              disabled={!stripReady() || !selected()?.canGoBack}
              onClick={() => runOnSelected((api) => api.back())}
              aria-label={language.t("desktop.menu.back")}
            />
          </TooltipV2>
          <TooltipV2 value={language.t("desktop.menu.forward")} placement="bottom" gutter={10}>
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-5 w-5"
              disabled={!stripReady() || !selected()?.canGoForward}
              onClick={() => runOnSelected((api) => api.forward())}
              aria-label={language.t("desktop.menu.forward")}
            />
          </TooltipV2>
          <Show
            when={selected()?.loading}
            fallback={
              <TooltipV2 value={language.t("desktop.menu.reload")} placement="bottom" gutter={10}>
                <IconButton
                  icon="reset"
                  variant="ghost"
                  class="h-5 w-5"
                  disabled={!stripReady() || !selected()?.attached}
                  onClick={() => runOnSelected((api) => api.reload())}
                  aria-label={language.t("desktop.menu.reload")}
                />
              </TooltipV2>
            }
          >
            <TooltipV2 value={language.t("desktop.browser.stop")} placement="bottom" gutter={10}>
              <IconButton
                icon="stop"
                variant="ghost"
                  class="h-5 w-5"
                  disabled={!stripReady()}
                  onClick={() => runOnSelected((api) => api.stop())}
                aria-label={language.t("desktop.browser.stop")}
              />
            </TooltipV2>
          </Show>
          <form
            data-component="browser-panel-address"
            class="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (!stripReady()) return
              go(state.input)
            }}
          >
            <TextInputV2
              value={state.input}
              onInput={(event) => setState("input", event.currentTarget.value)}
              onFocus={() => setState("editing", true)}
              onBlur={() => setState("editing", false)}
              placeholder={language.t("desktop.browser.address")}
              aria-label={language.t("desktop.browser.address")}
              spellcheck={false}
              disabled={!stripReady()}
            />
          </form>
          <TooltipV2
            value={
              state.picking ? language.t("desktop.browser.pick.cancel") : language.t("desktop.browser.pick.label")
            }
            placement="bottom"
            gutter={10}
          >
            <IconButton
              icon="window-cursor"
              variant="ghost"
              class="h-5 w-5"
              classList={{ "browser-panel-picking": state.picking }}
              disabled={!stripReady() || !selected()?.attached}
              onClick={pick}
              aria-label={
                state.picking ? language.t("desktop.browser.pick.cancel") : language.t("desktop.browser.pick.label")
              }
            />
          </TooltipV2>
          <Show when={props.onClose}>
            <TooltipV2 value={language.t("desktop.browser.close")} placement="bottom" gutter={10}>
              <IconButton
                icon="close"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => props.onClose?.()}
                aria-label={language.t("desktop.browser.close")}
              />
            </TooltipV2>
          </Show>
        </div>
        <Show when={state.picking}>
          <p data-component="browser-panel-pick-hint">{language.t("desktop.browser.pick.hint")}</p>
        </Show>
        <For each={state.tabs}>
          {(tab) => (
            <webview
              ref={(element) => attachGuest(tab.id, element as BrowserWebviewElement | undefined)}
              src={BLANK_URL}
              partition={partitionForTab(tab.id)}
              title={tab.title || tab.url}
              hidden={tab.id !== state.selectedId}
            />
          )}
        </For>
      </section>
    </Show>
  )
}

// The browser lives in the app shell (router root) so session-page remounts
// never unmount the webviews. The active session page publishes its slot
// frame; the layer only positions and shows/hides, guests stay attached.
export function BrowserHostLayer() {
  const host = useBrowserHost()
  const frame = () => host.frame()
  return (
    <div
      data-component="browser-host-layer"
      style={{
        position: "fixed",
        left: `${frame()?.left ?? 0}px`,
        top: `${frame()?.top ?? 0}px`,
        width: `${frame()?.width ?? 0}px`,
        height: `${frame()?.height ?? 0}px`,
        "z-index": 40,
        display: frame()?.visible ? "flex" : "none",
        "flex-direction": "column",
      }}
    >
      <BrowserPanel onClose={() => frame()?.close?.()} />
    </div>
  )
}
