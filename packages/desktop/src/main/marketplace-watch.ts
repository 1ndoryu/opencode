// OP-33 F3: pure thread-watch helpers (no Electron import, so bun:test can
// load this file directly — same split as marketplace-catalog in F2). Main
// only executes THREAD_TAIL_SCRIPT inside attached Marketplace guests and
// compares signatures; the renderer keeps the seen-map and the badges.
//
// Scope guard: the reader script runs ONLY in guests whose top-level URL
// matches isMarketplaceUrl. No network request to Meta is ever made — the
// read is local JS execution plus the catalog fetch the user already
// configured (their own API, loopback or https).
export type MarketplaceThreadState = {
  tabId: string
  threadKey: string
  title: string
  sig: string
}

// Top-level page URLs only: the host must be facebook.com (www/m/bare) and
// the path must mention marketplace. The trailing-slash requirement after
// the host keeps facebook.com.evil.com style lookalikes out.
const MARKETPLACE_URL = /^https?:\/\/(www\.|m\.)?facebook\.com\/\S*marketplace/i

export function isMarketplaceUrl(url: string): boolean {
  return MARKETPLACE_URL.test(url)
}

// Stable per-thread identity: the URL carries the thread (inbox thread ids
// live in its path/query) and the title carries the buyer name, so the key
// survives reloads. F4 memory (corrections, aviso cache) keys off this.
export function threadKeyFor(url: string, title: string): string {
  return `${url.trim()}|${title.replace(/\s+/g, " ").trim().slice(0, 120)}`
}

// Change signature over title + visible tail. djb2, same shape as the
// snapshot signature in browser-service (kept local so this module stays
// Electron-free).
export function signatureFor(title: string, tail: string): string {
  let hash = 5381
  const line = `${title}\n${tail}`
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0
  return String(hash)
}

// Lightweight guest read: document.title (buyer/listing) plus the tail of
// the visible text (newest messages render at the bottom). innerText forces
// layout, so the tail is capped and the poll only runs while the strip is
// open and only in Marketplace guests — see the component interval.
export const THREAD_TAIL_SCRIPT = `(() => {
  const text = (document.body && document.body.innerText ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
  return { title: document.title || "", tail: text.slice(-1500) };
})()`

// Validates the guest script result; anything else means the page did not
// answer with readable text and the guest is skipped for this round.
export function parseThreadTail(value: unknown): { title: string; tail: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.title !== "string" || typeof record.tail !== "string") return null
  return { title: record.title, tail: record.tail }
}
