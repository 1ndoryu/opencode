import type { WebPreferences } from "electron"

export const browserPartition = "persist:propio-browser"

export function resolveBrowserURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:") return url.href
  return undefined
}

export function enforceGuestPreferences(preferences: WebPreferences) {
  // The renderer declares the <webview> tag, but main owns the guest boundary:
  // strip anything that could bridge Node, preloads, or nested guests into web content.
  preferences.nodeIntegration = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webviewTag = false
  preferences.preload = undefined
  preferences.additionalArguments = []
  preferences.partition = browserPartition
}
