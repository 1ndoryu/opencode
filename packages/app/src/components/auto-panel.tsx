import { DockShell } from "@opencode-ai/ui/dock-surface"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

// Auto-mode box (OP-41 rev.7 F2). Thin server-state control over
// GET/PUT /session/:id/auto: one power switch plus the goal in a single
// framed box, no history. The autonomous loop runs server-side; this
// component keeps no driver, timer or message polling.
const GOAL_SAVE_DEBOUNCE_MS = 600

export function AutoPanelMount(props: { sessionID: string | undefined; working: () => boolean }) {
  const language = useLanguage()
  const sdk = useSDK()
  const fallback = () => language.t("auto.prompt.default")
  const [enabled, setEnabled] = createSignal(true)
  const [goal, setGoal] = createSignal(fallback())
  const [rows, setRows] = createSignal(2)
  let loadToken = 0
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const clearPendingSave = () => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
  }

  const readState = async (id: string) => {
    const token = (loadToken += 1)
    try {
      const res = await sdk().client.session.auto.get({ sessionID: id })
      const data = res?.data
      if (token !== loadToken || props.sessionID !== id) return
      if (!data || typeof data.enabled !== "boolean") return
      const nextGoal = typeof data.goal === "string" && data.goal ? data.goal : fallback()
      setEnabled(data.enabled)
      setGoal(nextGoal)
      setRows(nextGoal.split("\n").length <= 2 ? 2 : 3)
    } catch {
      // Backend unreachable: keep current values; the next session
      // switch or toggle re-syncs.
    }
  }

  const writeState = async (id: string, next: { enabled: boolean; goal?: string }) => {
    try {
      const res = await sdk().client.session.auto.update({
        sessionID: id,
        enabled: next.enabled,
        goal: next.goal,
      })
      if (!res?.data || typeof res.data.enabled !== "boolean") throw new Error("respuesta vacía")
    } catch {
      // Revert to the server value when the write fails.
      if (props.sessionID === id) void readState(id)
    }
  }

  const applyEnabled = (next: boolean) => {
    const id = props.sessionID
    setEnabled(next)
    if (!id) return
    void writeState(id, { enabled: next, goal: goal().trim() || undefined })
  }

  const applyGoalInput = (value: string) => {
    const id = props.sessionID
    setGoal(value)
    setRows(value.split("\n").length <= 2 ? 2 : 3)
    if (!id) return
    clearPendingSave()
    const snapshot = value.trim() || undefined
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (props.sessionID !== id) return
      void writeState(id, { enabled: enabled(), goal: snapshot })
    }, GOAL_SAVE_DEBOUNCE_MS)
  }

  // Server is the source of truth: reload on every session switch.
  createEffect(() => {
    const id = props.sessionID
    clearPendingSave()
    if (!id) return
    void readState(id)
  })

  onCleanup(() => clearPendingSave())

  return (
    <Show when={props.sessionID}>
      <div data-component="auto-panel" class="mb-2">
        <DockShell class="flex items-center gap-2 px-3 py-2">
          <Switch checked={enabled()} onChange={applyEnabled} hideLabel>
            {enabled() ? language.t("auto.toggle.disable") : language.t("auto.toggle.enable")}
          </Switch>
          <textarea
            class="min-w-0 flex-1 resize-none bg-transparent text-12-regular outline-none"
            rows={rows()}
            value={goal()}
            placeholder={language.t("auto.prompt.placeholder")}
            aria-label={language.t("auto.prompt.placeholder")}
            onInput={(event) => applyGoalInput(event.currentTarget.value)}
          />
        </DockShell>
      </div>
    </Show>
  )
}
