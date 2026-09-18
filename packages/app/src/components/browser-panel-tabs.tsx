import { For, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import "./browser-panel.css"

export type BrowserTabInfo = {
  id: string
  title: string
  url: string
}

export function BrowserPanelTabs(props: {
  tabs: BrowserTabInfo[]
  selectedId: string
  /** Live tabs across every strip: × shows on a lone visible tab while the pool has more (I9). */
  totalCount: number
  canAdd: boolean
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onAdd: () => void
}) {
  const language = useLanguage()
  return (
    <div data-component="browser-panel-tabs">
      <For each={props.tabs}>
        {(tab) => (
          <div data-component="browser-panel-tab" classList={{ selected: tab.id === props.selectedId }}>
            <button
              type="button"
              class="browser-panel-tab-label"
              title={tab.url}
              onClick={() => props.onSelect(tab.id)}
            >
              {tab.title || tab.url || tab.id}
            </button>
            <Show when={props.tabs.length > 1 || props.totalCount > 1}>
              <IconButton
                icon="close"
                variant="ghost"
                class="browser-panel-tab-close"
                onClick={() => props.onClose(tab.id)}
                aria-label={language.t("desktop.browser.tab.close")}
              />
            </Show>
          </div>
        )}
      </For>
      <Show when={props.canAdd}>
        <TooltipV2 value={language.t("desktop.browser.tab.new")} placement="bottom" gutter={10}>
          <IconButton
            icon="plus"
            variant="ghost"
            class="h-5 w-5"
            onClick={props.onAdd}
            aria-label={language.t("desktop.browser.tab.new")}
          />
        </TooltipV2>
      </Show>
    </div>
  )
}
