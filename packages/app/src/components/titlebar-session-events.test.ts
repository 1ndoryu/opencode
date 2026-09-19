import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  notifySessionTabsRemoved,
  readSessionTabsRemovedDetail,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: 42, sessionIDs: ["ses_1"] },
        }),
      ),
    ).toBeUndefined()
  })

  test("reads removed session tab details without directory (OP-29 sync deletes)", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { sessionIDs: ["ses_1"] },
        }),
      ),
    ).toEqual({ server: undefined, directory: undefined, sessionIDs: ["ses_1"] })
  })

  test("notify is a no-op without window (bun tests, SSR)", () => {
    expect(() => notifySessionTabsRemoved({ sessionIDs: ["ses_1"] })).not.toThrow()
  })
})
