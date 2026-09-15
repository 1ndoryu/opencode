import { For, Show, onCleanup, onMount } from "solid-js"
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

export function BrowserPanel(props: { onClose?: () => void }) {
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
  })
  let nextTab = 2

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
    if (tabId === state.selectedId && !state.editing) setState("input", next.url)
  }

  // Toolbar actions run against the selected tab server-side; the captured
  // tabId routes the result back even if selection moved mid-request.
  const runOnSelected = (run: (api: NonNullable<ReturnType<typeof browser>>) => Promise<BrowserPanelState>) => {
    const api = browser()
    const tabId = state.selectedId
    if (!api) return
    run(api).then((next) => apply(tabId, next))
  }

  const go = (raw: string) => {
    const api = browser()
    const value = raw.trim()
    if (!api || !value) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setState("input", url)
    runOnSelected((target) => target.navigate(url))
    void platform.storage?.(BROWSER_STORAGE).setItem(lastUrlKey(state.selectedId), url)
  }

  const selectTab = (tabId: string) => {
    if (tabIndex(tabId) < 0) return
    setState("selectedId", tabId)
    const tab = selected()
    if (tab && !state.editing) setState("input", tab.url)
    void browser()?.selectTab(tabId).catch(() => undefined)
  }

  const addTab = () => {
    if (state.tabs.length >= MAX_TABS) return
    const id = `t${nextTab}`
    nextTab += 1
    setState("tabs", (tabs) => [...tabs, blankTab(id)])
    selectTab(id)
  }

  const closeTab = (tabId: string) => {
    if (state.tabs.length <= 1) return
    const index = tabIndex(tabId)
    if (index < 0) return
    void browser()?.detach(tabId).catch(() => undefined)
    const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1]
    setState("tabs", (tabs) => tabs.filter((tab) => tab.id !== tabId))
    if (tabId === state.selectedId && neighbor) selectTab(neighbor.id)
  }

  const attachGuest = (tabId: string, element: BrowserWebviewElement | undefined) => {
    if (!element) return
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
          return platform.storage?.(BROWSER_STORAGE).getItem(lastUrlKey(tabId))
        })
        .then((last) => {
          // A restored URL belongs to this tab: select it first so go()
          // navigates here instead of the currently selected tab.
          if (last) {
            selectTab(tabId)
            go(last)
          }
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
    const api = browser()
    if (!api) return
    const stopListening = api.onState((update) => {
      if (update.state) apply(update.tabId, update.state)
    })
    // The agent acting on a background tab flips the panel to it, so the
    // user sees what the agent is doing.
    const stopSelect = api.onSelectTab((tabId) => {
      if (tabIndex(tabId) < 0) return
      setState("selectedId", tabId)
      const tab = selected()
      if (tab && !state.editing) setState("input", tab.url)
    })
    onCleanup(() => {
      stopListening()
      stopSelect()
      if (state.picking) void api.cancelPick().catch(() => undefined)
      for (const tab of state.tabs) void api.detach(tab.id).catch(() => undefined)
    })
  })

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
