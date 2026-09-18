import { describe, expect, test } from "bun:test"
import {
  chooseStrip,
  dropStripTab,
  firstFreeTabId,
  migrateLegacyStrips,
  parseLegacySessionTabs,
  parseSessionStrips,
  recordAgentTab,
  recordStrip,
  reservedStripIds,
  sessionForTab,
  shouldFollowAgentTab,
  shouldRestore,
  stripUrlKey,
  type SessionStrip,
  type SessionTabView,
} from "./browser-session-tabs"

const tab = (id: string, touched = false, lastUsed = 0): SessionTabView => ({ id, touched, lastUsed })
const strip = (tabs: string[], selected: string): SessionStrip => ({ tabs, selected })

describe("chooseStrip", () => {
  test("does nothing without a session", () => {
    expect(chooseStrip({ sessionID: undefined, live: [tab("t1")], strips: {}, maxTabs: 8 })).toEqual({
      action: "none",
    })
  })

  test("selects the strip's tab when it is still live", () => {
    expect(
      chooseStrip({
        sessionID: "ses_a",
        live: [tab("t1", true, 3), tab("t2", true, 9)],
        strips: { ses_a: strip(["t1", "t2"], "t2") },
        maxTabs: 8,
      }),
    ).toEqual({ action: "select", tabId: "t2" })
  })

  test("selects a surviving strip tab when selected went stale", () => {
    expect(
      chooseStrip({
        sessionID: "ses_a",
        live: [tab("t1", true, 5), tab("t2", true, 9)],
        strips: { ses_a: strip(["t1", "t9"], "t9") },
        maxTabs: 8,
      }),
    ).toEqual({ action: "select", tabId: "t1" })
  })

  test("creates a new tab instead of stealing an owned blank one", () => {
    expect(
      chooseStrip({
        sessionID: "ses_b",
        live: [tab("t1", false, 5)],
        strips: { ses_a: strip(["t1"], "t1") },
        maxTabs: 8,
      }),
    ).toEqual({ action: "create" })
  })

  test("adopts a blank tab nobody owns", () => {
    expect(
      chooseStrip({
        sessionID: "ses_b",
        live: [tab("t1", true, 5), tab("t2")],
        strips: { ses_a: strip(["t1"], "t1") },
        maxTabs: 8,
      }),
    ).toEqual({ action: "adopt", tabId: "t2" })
  })

  test("adopts a blank tab when the session has no strip yet", () => {
    expect(chooseStrip({ sessionID: "ses_b", live: [tab("t1")], strips: {}, maxTabs: 8 })).toEqual({
      action: "adopt",
      tabId: "t1",
    })
  })

  test("I6: prefers the persisted strip over an untouched spare after restart", () => {
    expect(
      chooseStrip({
        sessionID: "ses_a",
        live: [tab("t1")],
        strips: { ses_a: strip(["t9"], "t9") },
        maxTabs: 8,
      }),
    ).toEqual({ action: "select", tabId: "t9" })
  })

  test("evicts the least-recently-used live tab when the pool is hogged", () => {
    expect(
      chooseStrip({
        sessionID: "ses_c",
        live: [tab("t1", true, 30), tab("t2", true, 10)],
        strips: { ses_a: strip(["t1"], "t1"), ses_b: strip(["t2"], "t2") },
        maxTabs: 2,
      }),
    ).toEqual({ action: "evict", tabId: "t2" })
  })

  test("evicts an unowned tab before an owned one", () => {
    expect(
      chooseStrip({
        sessionID: "ses_c",
        live: [tab("t1", true, 30), tab("t2", true, 5)],
        strips: { ses_a: strip(["t2"], "t2") },
        maxTabs: 2,
      }),
    ).toEqual({ action: "evict", tabId: "t1" })
  })

  test("creates when there are no tabs at all", () => {
    expect(chooseStrip({ sessionID: "ses_a", live: [], strips: {}, maxTabs: 8 })).toEqual({ action: "create" })
  })
})

describe("session strips", () => {
  test("parseSessionStrips drops malformed entries", () => {
    expect(parseSessionStrips(undefined)).toEqual({})
    expect(parseSessionStrips("not json")).toEqual({})
    expect(parseSessionStrips(JSON.stringify(["t1"]))).toEqual({})
    expect(
      parseSessionStrips(
        JSON.stringify({
          good: { tabs: ["t1", "t2"], selected: "t2" },
          empty: { tabs: [], selected: "t1" },
          legacy: "t1",
          bad: { tabs: ["nope"], selected: "nope" },
        }),
      ),
    ).toEqual({ good: { tabs: ["t1", "t2"], selected: "t2" } })
  })

  test("migrateLegacyStrips turns single tabs into strips", () => {
    expect(parseLegacySessionTabs(JSON.stringify({ ses_a: "t1", ses_b: "nope" }))).toEqual({ ses_a: "t1" })
    expect(migrateLegacyStrips({ ses_a: "t1", ses_b: "nope", ses_c: "t2" })).toEqual({
      ses_a: { tabs: ["t1"], selected: "t1" },
      ses_c: { tabs: ["t2"], selected: "t2" },
    })
  })

  test("recordStrip refuses ids owned by another strip (I1, fail-closed)", () => {
    // Focus path (selectTab -> claimTab) must never destroy the owner's
    // strip: legitimate adopt/create paths use fresh ids (firstFreeTabId over
    // reservedStripIds) so they never overlap; matches recordAgentTab.
    expect(recordStrip({ ses_a: strip(["t1", "t2"], "t1") }, "ses_b", strip(["t2"], "t2"))).toEqual({
      ses_a: strip(["t1", "t2"], "t1"),
    })
  })

  test("recordStrip refuses even when the owner's selected tab is stale", () => {
    expect(recordStrip({ ses_a: strip(["t1", "t2"], "t2") }, "ses_b", strip(["t2"], "t2"))).toEqual({
      ses_a: strip(["t1", "t2"], "t2"),
    })
  })

  test("dropStripTab forgets closed tabs and deletes emptied strips", () => {
    expect(dropStripTab({ ses_a: strip(["t1"], "t1"), ses_b: strip(["t1", "t2"], "t2") }, "t1")).toEqual({
      ses_b: strip(["t2"], "t2"),
    })
  })

  test("sessionForTab finds the owning session", () => {
    expect(sessionForTab({ ses_a: strip(["t1"], "t1") }, "t1")).toBe("ses_a")
    expect(sessionForTab({ ses_a: strip(["t1"], "t1") }, "t2")).toBeUndefined()
  })

  test("reservedStripIds unions live and listed ids", () => {
    expect(reservedStripIds(["t1"], { ses_a: strip(["t2", "t3"], "t2") }).sort()).toEqual(["t1", "t2", "t3"])
  })

  test("firstFreeTabId recycles closed ids", () => {
    expect(firstFreeTabId(["t1", "t3"], 8)).toBe("t2")
    expect(firstFreeTabId(["t1", "t2"], 2)).toBeUndefined()
  })

  test("stripUrlKey scopes a page to its session and tab", () => {
    expect(stripUrlKey("ses_a", "t2")).toBe("sessionTabUrl-ses_a-t2")
  })

  test("shouldFollowAgentTab follows the viewed session's own tabs", () => {
    const strips = { ses_a: strip(["t1"], "t1"), ses_b: strip(["t2"], "t2") }
    expect(shouldFollowAgentTab({ tabId: "t1", strips, viewedSessionID: "ses_a" })).toBe(true)
  })

  test("shouldFollowAgentTab ignores tabs owned by another session", () => {
    const strips = { ses_a: strip(["t1"], "t1"), ses_b: strip(["t2"], "t2") }
    expect(shouldFollowAgentTab({ tabId: "t2", strips, viewedSessionID: "ses_a" })).toBe(false)
  })

  test("shouldFollowAgentTab stays put for ownerless tabs and sessionless views (I7)", () => {
    const strips = { ses_a: strip(["t1"], "t1") }
    expect(shouldFollowAgentTab({ tabId: "t9", strips, viewedSessionID: "ses_a" })).toBe(false)
    expect(shouldFollowAgentTab({ tabId: "t1", strips, viewedSessionID: undefined })).toBe(false)
  })

  test("I7 fail-closed: acting session without a viewed session does not follow", () => {
    const strips = { ses_a: strip(["t1"], "t1") }
    expect(
      shouldFollowAgentTab({ tabId: "t1", strips, viewedSessionID: undefined, agentSessionID: "ses_a" }),
    ).toBe(false)
  })

  test("shouldFollowAgentTab follows only the acting session's own view", () => {
    const strips = { ses_a: strip(["t1"], "t1"), ses_b: strip(["t2"], "t2") }
    expect(shouldFollowAgentTab({ tabId: "t2", strips, viewedSessionID: "ses_a", agentSessionID: "ses_b" })).toBe(
      false,
    )
    expect(shouldFollowAgentTab({ tabId: "t2", strips, viewedSessionID: "ses_b", agentSessionID: "ses_b" })).toBe(true)
  })

  test("recordAgentTab files the tab under the acting session without stealing", () => {
    expect(recordAgentTab({ ses_a: strip(["t1"], "t1") }, "ses_b", "t2")).toEqual({
      ses_a: strip(["t1"], "t1"),
      ses_b: strip(["t2"], "t2"),
    })
    expect(recordAgentTab({ ses_a: strip(["t1"], "t1") }, "ses_b", "t1")).toEqual({ ses_a: strip(["t1"], "t1") })
    expect(recordAgentTab({ ses_a: strip(["t1"], "t1") }, undefined, "t2")).toEqual({ ses_a: strip(["t1"], "t1") })
  })
})

describe("shouldRestore", () => {
  // Full decision matrix for the R0b seam: only an attached, still-blank,
  // still-selected tab with a resolved stored page restores. Every other
  // combination stays put (no navigation into a dead, dirty, background,
  // or pageless tab).
  const cases: Array<
    [{ attached: boolean; isBlank: boolean; isSelected: boolean; storedUrl: string | undefined }, boolean]
  > = [
    [{ attached: true, isBlank: true, isSelected: true, storedUrl: "https://a.example" }, true],
    [{ attached: true, isBlank: true, isSelected: true, storedUrl: undefined }, false],
    [{ attached: true, isBlank: true, isSelected: false, storedUrl: "https://a.example" }, false],
    [{ attached: true, isBlank: true, isSelected: false, storedUrl: undefined }, false],
    [{ attached: true, isBlank: false, isSelected: true, storedUrl: "https://a.example" }, false],
    [{ attached: true, isBlank: false, isSelected: true, storedUrl: undefined }, false],
    [{ attached: true, isBlank: false, isSelected: false, storedUrl: "https://a.example" }, false],
    [{ attached: true, isBlank: false, isSelected: false, storedUrl: undefined }, false],
    [{ attached: false, isBlank: true, isSelected: true, storedUrl: "https://a.example" }, false],
    [{ attached: false, isBlank: true, isSelected: true, storedUrl: undefined }, false],
    [{ attached: false, isBlank: true, isSelected: false, storedUrl: "https://a.example" }, false],
    [{ attached: false, isBlank: true, isSelected: false, storedUrl: undefined }, false],
    [{ attached: false, isBlank: false, isSelected: true, storedUrl: "https://a.example" }, false],
    [{ attached: false, isBlank: false, isSelected: true, storedUrl: undefined }, false],
    [{ attached: false, isBlank: false, isSelected: false, storedUrl: "https://a.example" }, false],
    [{ attached: false, isBlank: false, isSelected: false, storedUrl: undefined }, false],
  ]
  for (const [input, expected] of cases) {
    test(`attached=${String(input.attached)} blank=${String(input.isBlank)} selected=${String(input.isSelected)} stored=${input.storedUrl ?? "none"} → ${String(expected)}`, () => {
      expect(shouldRestore(input)).toBe(expected)
    })
  }
})
