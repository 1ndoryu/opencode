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
  // sessionID -> touched strip tabs: sessions with a real page in their
  // strip, so the side panel can offer and remember the browser tab per
  // conversation (OP-24). Untouched blanks don't count: every viewed
  // session gets a strip, only navigated tabs mean "browser in use".
  const [browserPages, setBrowserPages] = createSignal<Record<string, number>>({})
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
    browserPages,
    publishBrowserPages(next: Record<string, number>) {
      setBrowserPages(next)
    },
  }
}

export const { use: useBrowserHost, provider: BrowserHostProvider } = createSimpleContext({
  name: "BrowserHost",
  gate: false,
  init: () => createBrowserHost(),
})
