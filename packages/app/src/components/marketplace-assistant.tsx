import { For, Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type MarketplaceBorrador, type MarketplaceCatalog } from "@/context/platform"
import { showToast } from "@/utils/toast"

// OP-33 F2: manual Marketplace draft strip inside the browser chrome (never
// inside Facebook's DOM). Read-only by design: the user pastes the buyer's
// message, picks a draft and copies it. Nothing is ever sent automatically.
const API_URL_KEY = "marketplace.apiUrl"
const DEFAULT_API_URL = "https://mn-inmobiliaria.com"

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
  })

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
