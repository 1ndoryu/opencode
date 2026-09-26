import { For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import {
  usePlatform,
  type MarketplaceBorrador,
  type MarketplaceCatalog,
  type MarketplaceThreadState,
} from "@/context/platform"
import { showToast } from "@/utils/toast"

// OP-33 F2: manual Marketplace draft strip inside the browser chrome (never
// inside Facebook's DOM). Read-only by design: the user pastes the buyer's
// message, picks a draft and copies it. Nothing is ever sent automatically.
// OP-33 F3: bounded thread watch, fully manual (no background interval: the
// user presses refresh, main reads the attached Marketplace tabs once —
// Marketplace URLs only, title + text tail, no network to Meta — and the
// strip badges threads whose signature moved since last seen). Drafts stay
// behind their own generate button, so nothing runs on its own.
const API_URL_KEY = "marketplace.apiUrl"
const SEEN_KEY = "marketplace.seen"
const DEFAULT_API_URL = "https://mn-inmobiliaria.com"

function readSeen(): Record<string, string> {
  const raw = localStorage.getItem(SEEN_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

export function MarketplaceAssistant() {
  const language = useLanguage()
  const platform = usePlatform()
  const [state, setState] = createStore({
    apiUrl: localStorage.getItem(API_URL_KEY) ?? DEFAULT_API_URL,
    mensaje: "",
    tituloFb: "",
    catalog: null as MarketplaceCatalog | null,
    drafts: [] as MarketplaceBorrador[],
    generated: false,
    loadingCatalog: false,
    loadingDrafts: false,
    copied: -1,
    threads: [] as MarketplaceThreadState[],
    seen: readSeen(),
  })

  const poll = async () => {
    const api = platform.marketplace
    if (!api) return
    const threads = await api
      .poll({
        strings: {
          regenerate: language.t("desktop.browser.assistant.watch.regenerate"),
          copied: language.t("desktop.browser.assistant.copied"),
        },
        catalogo: state.catalog?.avisos,
      })
      .catch(() => null)
    if (threads) setState("threads", threads)
  }

  const markSeen = (thread: MarketplaceThreadState) => {
    const seen = { ...state.seen, [thread.threadKey]: thread.sig }
    setState("seen", seen)
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  }

  const unseen = (thread: MarketplaceThreadState) => state.seen[thread.threadKey] !== thread.sig

  const loadCatalog = async (refresh: boolean) => {
    const api = platform.marketplace
    if (!api) return
    setState("loadingCatalog", true)
    localStorage.setItem(API_URL_KEY, state.apiUrl)
    const catalog = await api.catalog({ apiUrl: state.apiUrl, refresh }).catch(() => null)
    if (catalog) setState("catalog", catalog)
    setState("loadingCatalog", false)
  }

  const generate = async () => {
    const api = platform.marketplace
    const mensaje = state.mensaje.trim()
    if (!api || mensaje === "" || state.loadingDrafts) return
    setState("loadingDrafts", true)
    const drafts = await api
      .drafts({ mensaje, tituloFb: state.tituloFb.trim(), catalogo: state.catalog?.avisos })
      .catch(() => null)
    if (drafts) setState({ drafts, generated: true, copied: -1 })
    setState("loadingDrafts", false)
  }

  const copy = async (texto: string, index: number) => {
    const done = await navigator.clipboard?.writeText(texto).then(
      () => true,
      () => false,
    )
    if (done) {
      setState("copied", index)
      setTimeout(() => setState("copied", -1), 2000)
      return
    }
    showToast({ title: language.t("desktop.browser.assistant.copy.failed") })
  }

  onMount(() => void loadCatalog(false))

  const updatedAt = () =>
    state.catalog && state.catalog.fetchedAt > 0
      ? new Date(state.catalog.fetchedAt).toLocaleTimeString()
      : null

  return (
    <div data-component="marketplace-assistant" class="flex flex-col gap-2 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold">{language.t("desktop.browser.assistant.toggle")}</span>
        <span class="min-w-0 flex-1 truncate text-xs opacity-70">
          <Show when={state.catalog} fallback={language.t("desktop.browser.assistant.catalog.empty")}>
            {language.t("desktop.browser.assistant.catalog.count", { count: state.catalog?.avisos.length ?? 0 })}
            <Show when={updatedAt()}>
              {" · "}
              {language.t("desktop.browser.assistant.catalog.updated", { time: updatedAt() ?? "" })}
            </Show>
          </Show>
        </span>
        <TooltipV2 value={language.t("desktop.browser.assistant.catalog.refresh")} placement="bottom" gutter={10}>
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-5 w-5"
            disabled={state.loadingCatalog}
            onClick={() => void loadCatalog(true)}
            aria-label={language.t("desktop.browser.assistant.catalog.refresh")}
          />
        </TooltipV2>
      </div>
      <Show when={state.catalog?.error}>
        <p class="text-xs opacity-70">{state.catalog?.error}</p>
      </Show>
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold">{language.t("desktop.browser.assistant.watch.title")}</span>
          <span class="min-w-0 flex-1" />
          <TooltipV2 value={language.t("desktop.browser.assistant.watch.refresh")} placement="bottom" gutter={10}>
            <IconButton
              icon="reset"
              variant="ghost"
              class="h-5 w-5"
              onClick={() => void poll()}
              aria-label={language.t("desktop.browser.assistant.watch.refresh")}
            />
          </TooltipV2>
        </div>
        <Show
          when={state.threads.length > 0}
          fallback={<p class="text-xs opacity-70">{language.t("desktop.browser.assistant.watch.none")}</p>}
        >
          <For each={state.threads}>
            {(thread) => (
              <div class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-xs opacity-70">{thread.title || thread.threadKey}</span>
                <Show when={unseen(thread)}>
                  <span class="text-xs font-semibold">{language.t("desktop.browser.assistant.watch.new")}</span>
                  <ButtonV2 type="button" variant="neutral" onClick={() => markSeen(thread)}>
                    {language.t("desktop.browser.assistant.watch.seen")}
                  </ButtonV2>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
      <TextInputV2
        value={state.apiUrl}
        onInput={(event) => setState("apiUrl", event.currentTarget.value)}
        placeholder={language.t("desktop.browser.assistant.apiUrl.label")}
        aria-label={language.t("desktop.browser.assistant.apiUrl.label")}
        spellcheck={false}
      />
      <TextareaV2
        value={state.mensaje}
        onInput={(event) => setState("mensaje", event.currentTarget.value)}
        placeholder={language.t("desktop.browser.assistant.message.placeholder")}
        aria-label={language.t("desktop.browser.assistant.message.label")}
        rows={2}
      />
      <div class="flex items-center gap-2">
        <TextInputV2
          value={state.tituloFb}
          onInput={(event) => setState("tituloFb", event.currentTarget.value)}
          placeholder={language.t("desktop.browser.assistant.listing.placeholder")}
          aria-label={language.t("desktop.browser.assistant.listing.label")}
          spellcheck={false}
        />
        <ButtonV2
          type="button"
          variant="contrast"
          disabled={state.mensaje.trim() === "" || state.loadingDrafts}
          onClick={() => void generate()}
        >
          {language.t("desktop.browser.assistant.generate")}
        </ButtonV2>
      </div>
      <Show when={!state.generated}>
        <p class="text-xs opacity-70">{language.t("desktop.browser.assistant.empty")}</p>
      </Show>
      <For each={state.drafts}>
        {(draft, index) => (
          <div class="flex items-start gap-2">
            <p class="min-w-0 flex-1 whitespace-pre-wrap text-xs">{draft.texto}</p>
            <ButtonV2 type="button" variant="neutral" onClick={() => void copy(draft.texto, index())}>
              {state.copied === index()
                ? language.t("desktop.browser.assistant.copied")
                : language.t("desktop.browser.assistant.copy")}
            </ButtonV2>
          </div>
        )}
      </For>
    </div>
  )
}
