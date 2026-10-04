import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { AutoController } from "@/utils/auto-controller"
import type { PanelVerdict } from "@/utils/auto-verdict"

// Collapsed-by-default auto-mode panel (OP-38 F0). Additive mount: renders
// a single ghost toggle; everything else hides behind it. Observation-only
// driver: monitors budget and verdicts, never injects prompts (the steer
// path needs the server-side driver, tracked as follow-up).
export function AutoPanelMount(props: { sessionID: string | undefined; working: () => boolean }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [prompt, setPrompt] = createSignal(readPrompt(props.sessionID))
  const [feed, setFeed] = createSignal<PanelVerdict[]>([])
  const [running, setRunning] = createSignal(false)
  const [turns, setTurns] = createSignal({ used: 0, max: 30 })
  const [warn, setWarn] = createSignal(false)
  let idleSince: number | null = null
  let sawWorking = false
  let controller: AutoController | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  onCleanup(stopTimer)

  const readLive = () => {
    const working = props.working()
    const now = Date.now()
    if (working) {
      sawWorking = true
      idleSince = null
    }
    if (!working && idleSince === null) idleSince = now
    return {
      working,
      pendingTools: false,
      tokenSilenceMs: idleSince === null ? 0 : now - idleSince,
      diffChanged: false,
      testsChanged: false,
      toolWithEffect: false,
      userQuestioned: false,
      checklistAdvanced: true,
      chatMode: false,
      idleTurns: 0,
      staleChecklistTurns: 0,
      sameErrorStreak: 0,
      externalComplete: false,
      userInput: false,
      permissionPending: false,
      permissionGranted: false,
    }
  }

  const refreshTurns = () => {
    const active = controller
    if (active) {
      setTurns({ used: active.turnsUsed, max: 30 })
      setWarn(active.warn80)
    }
  }

  const start = () => {
    const id = props.sessionID
    if (!id || controller?.isRunning) return
    writePrompt(id, prompt())
    const active = new AutoController(id, {
      readSignals: readLive,
      emit: (panel) => setFeed((items) => [...items.slice(-19), panel]),
    })
    controller = active
    sawWorking = false
    idleSince = null
    active.start()
    setRunning(true)
    stopTimer()
    timer = setInterval(() => {
      if (!sawWorking) return
      active.tick()
      refreshTurns()
      if (!active.isRunning) {
        setRunning(false)
        stopTimer()
      }
    }, 1000)
  }

  const stop = () => {
    controller?.stop("auto.reason.user")
    controller = null
    setRunning(false)
    stopTimer()
    refreshTurns()
  }

  return (
    <Show when={props.sessionID}>
      <div data-component="auto-panel" class="flex flex-col gap-2 px-3 pt-2">
        <ButtonV2
          size="small"
          variant="ghost"
          aria-label={open() ? language.t("auto.toggle.disable") : language.t("auto.toggle.enable")}
          onClick={() => setOpen((value) => !value)}
        >
          {open() ? language.t("auto.toggle.disable") : language.t("auto.toggle.enable")}
        </ButtonV2>
        <Show when={open()}>
          <textarea
            value={prompt()}
            placeholder={language.t("auto.prompt.placeholder")}
            aria-label={language.t("auto.prompt.placeholder")}
            rows={2}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
          <div class="text-12-regular text-text-weak">
            {language.t("auto.budget.turns", { used: turns().used, max: turns().max })}
            {" · "}
            {language.t("auto.cost.note")}
          </div>
          <Show when={warn() && running()}>
            <div class="text-12-regular text-text-weak">{language.t("auto.budget.warn80")}</div>
          </Show>
          <div class="flex gap-2">
            <Show when={!running()} fallback={<ButtonV2 size="small" variant="danger" onClick={stop}>{language.t("auto.stop")}</ButtonV2>}
            >
              <ButtonV2 size="small" variant="neutral" onClick={start} disabled={running()}>{language.t("auto.start")}</ButtonV2>
            </Show>
          </div>
          <For each={feed()}>
            {(item) => (
              <div class="text-12-regular text-text-weak">
                {language.t(item.headlineKey)}
                {" — "}
                {language.t(item.reasonKey)}
                <Show when={item.tools.length > 0}> ({item.tools.join(", ")})</Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

function promptKey(sessionID: string | undefined): string {
  return `auto.prompt.${sessionID ?? "none"}`
}

function readPrompt(sessionID: string | undefined): string {
  if (!sessionID) return ""
  try {
    return localStorage.getItem(promptKey(sessionID)) ?? ""
  } catch {
    return ""
  }
}

function writePrompt(sessionID: string, value: string): void {
  try {
    localStorage.setItem(promptKey(sessionID), value)
  } catch {
    // Storage full or unavailable: prompt stays session-local.
  }
}
