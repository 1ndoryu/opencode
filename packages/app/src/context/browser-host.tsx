import { createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { BrowserPickResult } from "@/context/platform"

// Viewport rect where the active session page wants the browser painted, plus
// the session the panel currently serves. The browser itself lives in the app
// shell (BrowserHostLayer) so session-page remounts never unmount webviews:
// the layer only positions and shows/hides, guests stay attached.
export type BrowserHostFrame = {
  // Guards publish/clear races when the old page unmounts after the new one
  // mounts: a clear only lands when it carries the visible frame's token.
  token: number
  sessionID?: string
  visible: boolean
  left: number
  top: number
  width: number
  height: number
  close?: () => void
}

// The shell panel has no prompt access, so the session page publishes how a
// picked element reaches the composer.
export type BrowserPickHandler = (result: BrowserPickResult) => Promise<void> | void

export function createBrowserHost() {
  const [frame, setFrame] = createSignal<BrowserHostFrame>()
  const [onPick, setOnPick] = createSignal<BrowserPickHandler>()
  return {
    frame,
    publish(next: BrowserHostFrame | undefined) {
      setFrame(next)
    },
    clear(token: number) {
      setFrame((current) => (current?.token === token ? undefined : current))
    },
    onPick,
    publishPick(next: BrowserPickHandler | undefined) {
      setOnPick(() => next)
    },
  }
}

export const { use: useBrowserHost, provider: BrowserHostProvider } = createSimpleContext({
  name: "BrowserHost",
  gate: false,
  init: () => createBrowserHost(),
})
