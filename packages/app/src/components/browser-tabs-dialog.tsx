import { For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

// OP-29: manager dialog over the whole live pool (every strip), so tabs
// orphaned by sync deletes or hidden behind eviction stay visible and
// closable. Rows are close-only: selecting a foreign tab here would paint
// another conversation's page into this panel (OP-17).
export type ManagedBrowserTab = {
  id: string
  title: string
  url: string
  /** Owning conversation, when the tab is listed in a strip. */
  owner?: string
}

export function BrowserTabsDialog(props: { tabs: ManagedBrowserTab[]; onClose: (tabId: string) => void }) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("desktop.browser.tabs.title")} size="normal" transition>
      <ul data-component="browser-tabs-dialog-list" class="flex min-w-72 flex-col gap-0.5">
        <For each={props.tabs}>
          {(tab) => (
            <li data-component="browser-tabs-dialog-row" class="flex min-w-0 items-center gap-2">
              <span class="shrink-0 font-mono text-xs opacity-60">{tab.id}</span>
              <span class="min-w-0 flex-1 truncate" title={tab.url || tab.id}>
                {tab.title || tab.url || tab.id}
              </span>
              {tab.owner && (
                <span class="shrink-0 font-mono text-xs opacity-60" title={tab.owner}>
                  {tab.owner.slice(0, 8)}
                </span>
              )}
              <IconButton
                icon="close"
                variant="ghost"
                class="h-5 w-5 shrink-0"
                onClick={() => props.onClose(tab.id)}
                aria-label={language.t("desktop.browser.tab.close")}
              />
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  )
}
