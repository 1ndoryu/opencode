import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type BrowserPanelState, type BrowserPickResult } from "@/context/platform"
import { usePrompt, type ElementAttachmentPart, type ImageAttachmentPart } from "@/context/prompt"
import { createBlobReference } from "@/utils/draft-store"
import { showToast } from "@/utils/toast"
import { uuid } from "@/utils/uuid"
import {
  chooseSessionTab,
  dropTabSessions,
  firstFreeTabId,
  parseSessionTabs,
  recordSessionTab,
  SESSION_TABS_KEY,
  sessionForTab,
  sessionUrlKey,
} from "./browser-session-tabs"
import { BrowserPanelTabs } from "./browser-panel-tabs"
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

export function BrowserPanel(props: { onClose?: () => void; sessionID?: string }) {
  const platform = usePlatform()
  const language = useLanguage()
  const prompt = usePrompt()
  const browser = () => platform.browser
  const [state, setState] = createStore({
    input: BLANK_URL,
    editing: false,
    picking: false,
    tabs: [blankTab("t1")],
    selectedId: "t1",
    // sessionID -> tabId: each conversation keeps its own tab, like the
    // context tab keeps its own data. Persisted; validated on load.
    sessionTabs: {} as Record<string, string>,
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

  const persistSessionTabs = (next: Record<string, string>, pruneUrlsFor: string[] = []) => {
    setState("sessionTabs", next)
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return
    void Promise.resolve(store.setItem(SESSION_TABS_KEY, JSON.stringify(next))).catch(() => undefined)
    // A session page survives steals and evictions (the session restores it
    // into its next tab); only an explicit tab close drops those pages.
    for (const sessionID of pruneUrlsFor)
      void Promise.resolve(store.removeItem(sessionUrlKey(sessionID))).catch(() => undefined)
  }

  // Persisted affinity, read fresh: state may still hold the initial empty map
  // while the mount load is in flight (attach restores race with it).
  const loadSessionTabs = async (): Promise<Record<string, string>> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return {}
    try {
      return parseSessionTabs(await store.getItem(SESSION_TABS_KEY))
    } catch {
      return {}
    }
  }

  // The active conversation claims this tab: main pins session -> tab so the
  // agent defaults to the page the user is looking at.
  const claimTab = (tabId: string) => {
    const sessionID = props.sessionID
    if (!sessionID) return
    persistSessionTabs(recordSessionTab(state.sessionTabs, sessionID, tabId))
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

  // Remembers the owner's page from any source (toolbar, agent, links,
  // back/forward): apply() sees them all via onState. Restore navigations
  // rewrite the same URL, so this stays idempotent.
  const rememberSessionPage = (tabId: string, url: string) => {
    const owner = sessionForTab(state.sessionTabs, tabId)
    if (!owner) return
    void Promise.resolve(platform.storage?.(BROWSER_STORAGE).setItem(sessionUrlKey(owner), url)).catch(
      () => undefined,
    )
  }

  // A tab that stayed blank (fresh mount, reassigned spare) shows its
  // session's page as soon as it is known.
  const restoreSessionPage = (sessionID: string, tabId: string) => {
    const index = tabIndex(tabId)
    if (index < 0 || !state.tabs[index].attached || state.tabs[index].url !== BLANK_URL) return
    void readSessionUrl(sessionID)
      .then((url) => {
        const current = tabIndex(tabId)
        if (!url || current < 0 || !state.tabs[current].attached || state.tabs[current].url !== BLANK_URL) return
        if (state.selectedId !== tabId) return
        go(url)
      })
      .catch(() => undefined)
  }

  // Switching conversations selects that conversation's tab (or finds it a
  // home), so the panel follows the session like the context tab does.
  const ensureSessionTab = (sessionID: string) => {
    const decision = chooseSessionTab({
      sessionID,
      tabs: state.tabs.map((tab) => ({
        id: tab.id,
        touched: state.touched[tab.id] ?? false,
        lastUsed: state.lastUsed[tab.id] ?? 0,
      })),
      sessionTabs: state.sessionTabs,
      maxTabs: MAX_TABS,
    })
    if (decision.action === "none") return
    if (decision.action === "select" || decision.action === "assign") {
      persistSessionTabs(recordSessionTab(state.sessionTabs, sessionID, decision.tabId))
      focusTab(decision.tabId)
      claimTab(decision.tabId)
      restoreSessionPage(sessionID, decision.tabId)
      return
    }
    if (decision.action === "create") {
      const id = addTabInternal()
      if (!id) return
      persistSessionTabs(recordSessionTab(state.sessionTabs, sessionID, id))
      claimTab(id)
      // Fresh webview: attachGuest restores the session URL on dom-ready.
      return
    }
    // Evict: closeTabInternal wipes the victim's jar in main, so the recycled
    // id starts clean; the victim keeps its session URL and restores it into
    // its next tab. The new webview restores this session's URL on attach.
    closeTabInternal(decision.tabId, false)
    const id = addTabInternal()
    if (!id) return
    persistSessionTabs(recordSessionTab(state.sessionTabs, sessionID, id))
    claimTab(id)
  }

  const go = (raw: string) => {
    const target = browser()
    const value = raw.trim()
    if (!target || !value) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setState("input", url)
    setState("touched", state.selectedId, true)
    setState("lastUsed", state.selectedId, Date.now())
    // Navigating claims the tab for this conversation and remembers the page
    // per session, so switching away and back restores it.
    claimTab(state.selectedId)
    runOnSelected((selected) => selected.navigate(url))
    void platform.storage?.(BROWSER_STORAGE).setItem(lastUrlKey(state.selectedId), url)
    const sessionID = props.sessionID
    if (sessionID) void platform.storage?.(BROWSER_STORAGE).setItem(sessionUrlKey(sessionID), url)
  }

  const selectTab = (tabId: string) => {
    focusTab(tabId)
    // Manual selection moves the conversation here too.
    claimTab(tabId)
  }

  const addTabInternal = () => {
    const id = firstFreeTabId(
      state.tabs.map((tab) => tab.id),
      MAX_TABS,
    )
    if (!id) return undefined
    setState("tabs", (tabs) => [...tabs, blankTab(id)])
    focusTab(id)
    return id
  }

  const addTab = () => {
    const id = addTabInternal()
    if (id) claimTab(id)
  }

  const closeTabInternal = (tabId: string, pruneUrls = true) => {
    if (state.tabs.length <= 1) return
    const index = tabIndex(tabId)
    if (index < 0) return
    const target = browser()
    if (target) void target.closeTab(tabId).catch(() => undefined)
    // Only an explicit close drops the evicted sessions' pages; steals and
    // evictions keep them so the session restores into its next tab.
    const evicted = pruneUrls ? Object.keys(state.sessionTabs).filter((key) => state.sessionTabs[key] === tabId) : []
    persistSessionTabs(dropTabSessions(state.sessionTabs, tabId), evicted)
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
    closeTabInternal(tabId)
    // Closing the visible tab moves the conversation to the neighbor.
    if (wasSelected && tabIndex(tabId) < 0) claimTab(state.selectedId)
  }

  // A tab owned by a conversation restores that conversation's page. The map
  // merges storage with state because attach restores race the mount load;
  // an unowned tab stays blank once affinity exists (the legacy per-tab URL
  // only upgrades pre-affinity profiles with an empty map).
  const restoreUrlFor = async (tabId: string): Promise<string | undefined> => {
    const store = platform.storage?.(BROWSER_STORAGE)
    if (!store) return undefined
    const mapping = { ...(await loadSessionTabs()), ...state.sessionTabs }
    const owner = sessionForTab(mapping, tabId)
    if (owner) return readSessionUrl(owner)
    if (Object.keys(mapping).length > 0) return undefined
    try {
      return (await store.getItem(lastUrlKey(tabId))) ?? undefined
    } catch {
      return undefined
    }
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
          // ensureSessionTab and manual selection.
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

  // Short badge label: the tag name only (div, p, h1...). Detail lives in
  // the part metadata and shows on hover via the pill title.
  const elementBadge = (element: BrowserPickResult["element"]) => {
    return element.tagName
  }

  const addPickedToPrompt = async (result: BrowserPickResult) => {
    const element = result.element
    const parts = [...prompt.current()]
    if (result.capture) {
      const file = new File([new Uint8Array(result.capture.buffer)], "element.png", { type: "image/png" })
      const store = platform.draftStore
      const blob = store ? await store.putBlob(file) : await createBlobReference(file)
      const image: ImageAttachmentPart = {
        type: "image",
        id: uuid(),
        filename: file.name,
        mime: "image/png",
        blob,
      }
      parts.push(image)
    }
    const badge = elementBadge(element)
    const pill: ElementAttachmentPart = {
      type: "element",
      content: badge,
      start: 0,
      end: 0,
      url: element.url,
      selector: element.selector,
      tagName: element.tagName,
      xpath: element.xpath,
      role: element.role,
      text: element.text,
      attributes: element.attributes,
      outerHtml: element.outerHtml,
    }
    parts.push(pill)
    prompt.set(parts)
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

  onMount(() => {
    const target = browser()
    if (!target) return
    const stopListening = target.onState((update) => {
      if (update.state) apply(update.tabId, update.state)
    })
    // The agent acting on a background tab flips the panel to it, so the
    // user sees what the agent is doing. Agent moves don't claim affinity:
    // main already pins that session server-side.
    const stopSelect = target.onSelectTab((tabId) => focusTab(tabId))
    onCleanup(() => {
      stopListening()
      stopSelect()
      if (state.picking) void target.cancelPick().catch(() => undefined)
      for (const tab of state.tabs) void target.detach(tab.id).catch(() => undefined)
    })
    // Affinity survives remounts; then the current conversation takes its tab.
    void (async () => {
      setState("sessionTabs", await loadSessionTabs())
      const sessionID = props.sessionID
      if (sessionID) ensureSessionTab(sessionID)
    })().catch(() => undefined)
  })

  // In-place conversation switches (same mounted panel, new session).
  createEffect(
    on(
      () => props.sessionID,
      (sessionID) => {
        if (sessionID) ensureSessionTab(sessionID)
      },
      { defer: true },
    ),
  )

  return (
    <Show when={browser()}>
      <section data-component="browser-panel" aria-label={language.t("desktop.browser.title")}>
        <BrowserPanelTabs
          tabs={state.tabs}
          selectedId={state.selectedId}
          canAdd={state.tabs.length < MAX_TABS}
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
              disabled={!selected()?.canGoBack}
              onClick={() => runOnSelected((api) => api.back())}
              aria-label={language.t("desktop.menu.back")}
            />
          </TooltipV2>
          <TooltipV2 value={language.t("desktop.menu.forward")} placement="bottom" gutter={10}>
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-5 w-5"
              disabled={!selected()?.canGoForward}
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
                  disabled={!selected()?.attached}
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
              disabled={!selected()?.attached}
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
