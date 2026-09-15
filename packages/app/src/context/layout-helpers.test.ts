import { describe, expect, test } from "bun:test"
import { sessionKeysForSessionID } from "./layout-helpers"
import { ServerScope, SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

const key = (dir: string, sessionID?: string, scope = ServerScope.local) =>
  SessionStateKey.from(scope, SessionRouteKey.fromRoute(dir, sessionID))

describe("sessionKeysForSessionID", () => {
  test("returns nothing without a session id", () => {
    expect(sessionKeysForSessionID({ view: [key("d", "s")], tabs: [], sessionID: "" })).toEqual([])
  })

  test("matches tabs and view keys by route suffix across directories", () => {
    const ownedTab = key("dir-a", "ses_123")
    const ownedView = key("dir-b", "ses_123")
    const workspace = key("dir-a")
    const other = key("dir-a", "ses_456")
    expect(
      sessionKeysForSessionID({ view: [ownedView, workspace], tabs: [ownedTab, other], sessionID: "ses_123" }).sort(),
    ).toEqual([ownedTab, ownedView].sort())
  })

  test("does not match a session id that is only a prefix of another", () => {
    const longer = key("dir-a", "ses_1234")
    expect(sessionKeysForSessionID({ view: [], tabs: [longer], sessionID: "ses_123" })).toEqual([])
  })

  test("matches across scopes", () => {
    const remote = key("dir-a", "ses_123", "remote" as ServerScope)
    expect(sessionKeysForSessionID({ view: [remote], tabs: [], sessionID: "ses_123" })).toEqual([remote])
  })
})
