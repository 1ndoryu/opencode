import type { Accessor } from "solid-js"
import { SessionStateKey } from "@/utils/server-scope"

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}

/**
 * Every remembered key (tabs + view) owned by a deleted conversation. Keys
 * are matched by route suffix: the directory part is base64url (no "/"), so
 * a trailing "/<sessionID>" is unambiguous across scopes and directories.
 */
export function sessionKeysForSessionID(input: { view: string[]; tabs: string[]; sessionID: string }) {
  if (!input.sessionID) return []
  const suffix = `/${input.sessionID}`
  const keys = new Set([...input.view, ...input.tabs])
  return Array.from(keys).filter((key) => SessionStateKey.route(key).endsWith(suffix))
}
