import { Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type BrowserPanelState } from "@/context/platform"
import "./browser-panel.css"

const BROWSER_PARTITION = "persist:propio-browser"
const BROWSER_STORAGE = "opencode.browser.dat"
const LAST_URL_KEY = "lastUrl"
const BLANK_URL = "about:blank"

/** Electron extends the guest element with guest APIs at runtime. */
type BrowserWebviewElement = HTMLElement & {
  getWebContentsId(): number
}

export function BrowserPanel(props: { onClose?: () => void }) {
  const platform = usePlatform()
  const language = useLanguage()
  const browser = () => platform.browser
  const [state, setState] = createStore({
    input: BLANK_URL,
    url: BLANK_URL,
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    attached: false,
    editing: false,
  })
  let webview: BrowserWebviewElement | undefined

  const apply = (next: BrowserPanelState) => {
    setState({
      url: next.url,
      title: next.title,
      loading: next.loading,
      canGoBack: next.canGoBack,
      canGoForward: next.canGoForward,
    })
    if (!state.editing) setState("input", next.url)
  }

  const go = (raw: string) => {
    const api = browser()
    const value = raw.trim()
    if (!api || !value) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    setState("input", url)
    api.navigate(url).then(apply)
    void platform.storage?.(BROWSER_STORAGE).setItem(LAST_URL_KEY, url)
  }

  onMount(() => {
    const api = browser()
    const guest = webview
    if (!api || !guest) return
    const stopListening = api.onState((next) => {
      if (next) apply(next)
    })
    const onReady = () => {
      api
        .attach(guest.getWebContentsId())
        .then((current) => {
          apply(current)
          setState("attached", true)
          return platform.storage?.(BROWSER_STORAGE).getItem(LAST_URL_KEY)
        })
        .then((last) => {
          if (last) go(last)
        })
    }
    guest.addEventListener("dom-ready", onReady, { once: true })
    onCleanup(() => {
      guest.removeEventListener("dom-ready", onReady)
      stopListening()
      void api.detach()
    })
  })

  return (
    <Show when={browser()}>
      <section data-component="browser-panel" aria-label={language.t("desktop.browser.title")}>
        <div data-component="browser-panel-toolbar" class="flex items-center gap-1 px-2 py-1.5">
          <TooltipV2 value={language.t("desktop.menu.back")} placement="bottom" gutter={10}>
            <IconButton
              icon="arrow-left"
              variant="ghost"
              class="h-5 w-5"
              disabled={!state.canGoBack}
              onClick={() => browser()?.back().then(apply)}
              aria-label={language.t("desktop.menu.back")}
            />
          </TooltipV2>
          <TooltipV2 value={language.t("desktop.menu.forward")} placement="bottom" gutter={10}>
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-5 w-5"
              disabled={!state.canGoForward}
              onClick={() => browser()?.forward().then(apply)}
              aria-label={language.t("desktop.menu.forward")}
            />
          </TooltipV2>
          <Show
            when={state.loading}
            fallback={
              <TooltipV2 value={language.t("desktop.menu.reload")} placement="bottom" gutter={10}>
                <IconButton
                  icon="reset"
                  variant="ghost"
                  class="h-5 w-5"
                  disabled={!state.attached}
                  onClick={() => browser()?.reload().then(apply)}
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
                onClick={() => browser()?.stop().then(apply)}
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
        <webview
          ref={(element) => {
            webview = element as BrowserWebviewElement
          }}
          src={BLANK_URL}
          partition={BROWSER_PARTITION}
          title={state.title || state.url}
        />
      </section>
    </Show>
  )
}
