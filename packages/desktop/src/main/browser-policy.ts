import type { WebPreferences } from "electron"

export const browserPartition = "persist:propio-browser"

export function resolveBrowserURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:") return url.href
  return undefined
}

// Agent-initiated navigation only. Blocks loopback/private/link-local hosts
// so a prompt-injected page cannot launder the agent into probing internal
// services (e.g. "open http://127.0.0.1:...", then exfiltrate the render).
// The user's own address bar keeps resolveBrowserURL (localhost allowed:
// dev preview is a legitimate panel use case).
export function resolveAgentURL(value: string) {
  const href = resolveBrowserURL(value)
  if (!href) return undefined
  if (isLocalHost(new URL(href).hostname.toLowerCase())) return undefined
  return href
}

function isLocalHost(host: string) {
  // WHATWG URL.hostname keeps IPv6 brackets: "[::1]".
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host.includes(":")) {
    // IPv6: ::1, fc00::/7, fe80::/10.
    if (host === "::1") return true
    const first = host.split(":")[0] ?? ""
    if (/^f[c-d]/i.test(first)) return true
    if (/^fe[89ab]/i.test(first)) return true
    return false
  }
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false
  const [a, b] = parts.map(Number)
  return (
    a === 127 || // loopback
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local
    a === 0 // unspecified
  )
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
