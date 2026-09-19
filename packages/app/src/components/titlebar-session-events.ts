import type { ServerConnection } from "@/context/server"

export const SESSION_TABS_REMOVED_EVENT = "opencode:session-tabs-removed"

export type SessionTabsRemovedDetail = {
  server?: ServerConnection.Key
  // OP-29: optional so sync-driven deletes (session.deleted / archived via
  // server-sync, which may only know the session id) can notify too.
  // Listeners only match on server + sessionIDs; directory is informational.
  directory?: string
  sessionIDs: string[]
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  // No-op outside the browser (bun tests, SSR): dispatching on undefined
  // window would throw and pure sync reducers must stay side-effect free.
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("sessionIDs" in detail)) return undefined
  if ("directory" in detail && detail.directory !== undefined && typeof detail.directory !== "string")
    return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined

  return {
    server:
      "server" in detail && typeof detail.server === "string" ? (detail.server as ServerConnection.Key) : undefined,
    directory: "directory" in detail && typeof detail.directory === "string" ? detail.directory : undefined,
    sessionIDs,
  }
}
