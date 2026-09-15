import { describe, expect, test } from "bun:test"
import {
  chooseSessionTab,
  dropTabSessions,
  firstFreeTabId,
  parseSessionTabs,
  recordSessionTab,
  sessionForTab,
  type SessionTabView,
} from "./browser-session-tabs"

const tab = (id: string, touched = false, lastUsed = 0): SessionTabView => ({ id, touched, lastUsed })

describe("chooseSessionTab", () => {
  test("does nothing without a session", () => {
    expect(
      chooseSessionTab({ sessionID: undefined, tabs: [tab("t1")], sessionTabs: {}, maxTabs: 8 }),
    ).toEqual({ action: "none" })
  })

  test("selects the mapped tab when it still exists", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_a",
        tabs: [tab("t1", true, 3), tab("t2", true, 9)],
        sessionTabs: { ses_a: "t1" },
        maxTabs: 8,
      }),
    ).toEqual({ action: "select", tabId: "t1" })
  })

  test("creates a new tab instead of stealing an owned blank one", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_b",
        tabs: [tab("t1", false, 5)],
        sessionTabs: { ses_a: "t1" },
        maxTabs: 8,
      }),
    ).toEqual({ action: "create" })
  })

  test("assigns a spare blank tab nobody owns", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_b",
        tabs: [tab("t1", true, 5), tab("t2")],
        sessionTabs: { ses_a: "t1" },
        maxTabs: 8,
      }),
    ).toEqual({ action: "assign", tabId: "t2" })
  })

  test("ignores a stale mapping and reuses the blank tab", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_a",
        tabs: [tab("t1")],
        sessionTabs: { ses_a: "t9" },
        maxTabs: 8,
      }),
    ).toEqual({ action: "assign", tabId: "t1" })
  })

  test("creates a tab when every tab is touched and there is room", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_b",
        tabs: [tab("t1", true, 5)],
        sessionTabs: {},
        maxTabs: 8,
      }),
    ).toEqual({ action: "create" })
  })

  test("evicts the least-recently-used tab when full", () => {
    expect(
      chooseSessionTab({
        sessionID: "ses_c",
        tabs: [tab("t1", true, 30), tab("t2", true, 10)],
        sessionTabs: {},
        maxTabs: 2,
      }),
    ).toEqual({ action: "evict", tabId: "t2" })
  })

  test("creates when there are no tabs at all", () => {
    expect(chooseSessionTab({ sessionID: "ses_a", tabs: [], sessionTabs: {}, maxTabs: 8 })).toEqual({
      action: "create",
    })
  })
})

describe("session tab affinity", () => {
  test("parseSessionTabs drops malformed entries", () => {
    expect(parseSessionTabs(undefined)).toEqual({})
    expect(parseSessionTabs("not json")).toEqual({})
    expect(parseSessionTabs(JSON.stringify(["t1"]))).toEqual({})
    expect(parseSessionTabs(JSON.stringify({ ses_a: "t1", ses_b: "nope", ses_c: 7 }))).toEqual({
      ses_a: "t1",
    })
  })

  test("recordSessionTab steals the tab from other sessions", () => {
    expect(recordSessionTab({ ses_a: "t1", ses_b: "t2" }, "ses_b", "t1")).toEqual({ ses_b: "t1" })
  })

  test("dropTabSessions forgets closed tabs only", () => {
    expect(dropTabSessions({ ses_a: "t1", ses_b: "t2" }, "t1")).toEqual({ ses_b: "t2" })
  })

  test("sessionForTab finds the owner", () => {
    expect(sessionForTab({ ses_a: "t1" }, "t1")).toBe("ses_a")
    expect(sessionForTab({ ses_a: "t1" }, "t2")).toBeUndefined()
  })

  test("firstFreeTabId recycles closed ids", () => {
    expect(firstFreeTabId(["t1", "t3"], 8)).toBe("t2")
    expect(firstFreeTabId(["t1", "t2"], 2)).toBeUndefined()
  })
})
