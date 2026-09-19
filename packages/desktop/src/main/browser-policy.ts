import type { WebPreferences } from "electron"
import { BROWSER_SHARED_PARTITION } from "./browser-tabs"

export const browserPartition = BROWSER_SHARED_PARTITION

export function resolveBrowserURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:") return url.href
  return undefined
}

// Agent-initiated navigation only. Loopback stays allowed (localhost dev
// preview is the panel's main use case); private LAN, link-local and
// unspecified hosts are blocked so a prompt-injected page cannot launder the
// agent into probing internal services or cloud metadata (e.g. 169.254.169.254)
// and exfiltrating the render.
export function resolveAgentURL(value: string) {
  const href = resolveBrowserURL(value)
  if (!href) return undefined
  if (isBlockedHost(new URL(href).hostname.toLowerCase())) return undefined
  return href
}

function isLoopback(host: string) {
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1") return true
  const parts = host.split(".")
  return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isBlockedHost(host: string) {
  if (isLoopback(host)) return false
  // WHATWG URL.hostname keeps IPv6 brackets: "[fe80::1]".
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (isLoopback(host)) return false
  if (host.includes(":")) {
    // IPv6: block unique-local (fc00::/7) and link-local (fe80::/10).
    const first = host.split(":")[0] ?? ""
    if (/^f[c-d]/i.test(first)) return true
    if (/^fe[89ab]/i.test(first)) return true
    return false
  }
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false
  const [a, b] = parts.map(Number)
  return (
    a === 10 || // private
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local + cloud metadata
    a === 0 // unspecified
  )
}

export function enforceGuestPreferences(preferences: WebPreferences) {
  // The renderer declares the <webview> tag, but main owns the guest boundary:
  // strip anything that could bridge Node, preloads, or nested guests into web content.
  // The partition is NOT forced here: every tab shares BROWSER_SHARED_PARTITION
  // by explicit user decision (OP-28: logins/cache survive closes, one
  // recognizable folder to wipe), and will-attach-webview allowlists it
  // (see browser-tabs isAllowedPartition); forcing a partition here would add
  // nothing and could only surprise.
  preferences.nodeIntegration = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webviewTag = false
  preferences.preload = undefined
  preferences.additionalArguments = []
}
