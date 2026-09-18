import { describe, expect, test } from "bun:test"
import {
  BROWSER_PARTITION_BASE,
  MAX_TABS,
  chooseAgentTabId,
  isAllowedPartition,
  isValidSessionID,
  isValidTabId,
  NoAgentTabError,
  partitionForTab,
  pinSession,
  pinnedKey,
  tabKey,
} from "./browser-tabs"

describe("browser tabs", () => {
  test("accepts renderer tab ids only", () => {
    expect(isValidTabId("t1")).toBe(true)
    expect(isValidTabId("t27")).toBe(true)
    expect(isValidTabId("t0")).toBe(false)
    expect(isValidTabId("tab1")).toBe(false)
    expect(isValidTabId("../../x")).toBe(false)
    expect(isValidTabId("t1;t2")).toBe(false)
    expect(isValidTabId(7)).toBe(false)
    expect(isValidTabId(undefined)).toBe(false)
  })

  test("keys scope tabs to their host window", () => {
    expect(tabKey(3, "t1")).toBe("3:t1")
    expect(tabKey(4, "t1")).not.toBe(tabKey(3, "t1"))
  })

  test("partitions isolate tabs under an allowlist", () => {
    expect(partitionForTab("t1")).toBe(`${BROWSER_PARTITION_BASE}-t1`)
    expect(isAllowedPartition(BROWSER_PARTITION_BASE)).toBe(true)
    expect(isAllowedPartition(partitionForTab("t2"))).toBe(true)
    expect(isAllowedPartition("persist:other")).toBe(false)
    expect(isAllowedPartition(`${BROWSER_PARTITION_BASE}-../../x`)).toBe(false)
    expect(isAllowedPartition(`${BROWSER_PARTITION_BASE}-t0`)).toBe(false)
  })

  test("pins remember a session tab and drop dead ones", () => {
    const pins = new Map<string, string>()
    pinSession(pins, "ses_1", "3:t1")
    expect(pinnedKey(pins, "ses_1", () => true)).toBe("3:t1")
    expect(pinnedKey(pins, "ses_1", () => false)).toBeUndefined()
    expect(pins.has("ses_1")).toBe(false)
    expect(pinnedKey(pins, "nope", () => true)).toBeUndefined()
    expect(pinnedKey(pins, "", () => true)).toBeUndefined()
  })

  test("pins stay bounded", () => {
    const pins = new Map<string, string>()
    for (let i = 0; i < 600; i++) pinSession(pins, `ses_${i}`, `3:t${(i % MAX_TABS) + 1}`)
    expect(pins.size).toBeLessThanOrEqual(500)
    expect(pins.has("ses_599")).toBe(true)
    expect(pinnedKey(pins, "ses_0", () => true)).toBeUndefined()
  })

  test("session ids are validated", () => {
    expect(isValidSessionID("ses_abc")).toBe(true)
    expect(isValidSessionID("")).toBe(false)
    expect(isValidSessionID("x".repeat(129))).toBe(false)
    expect(isValidSessionID(42)).toBe(false)
  })

  test("agent keeps the visible tab when nobody else pinned it", () => {
    expect(chooseAgentTabId({ tabIds: ["t1", "t2"], selectedTabId: "t1", otherPinnedTabIds: new Set() })).toBe("t1")
  })

  test("agent takes a spare tab instead of hijacking a foreign pin", () => {
    expect(chooseAgentTabId({ tabIds: ["t1", "t2"], selectedTabId: "t1", otherPinnedTabIds: ["t1"] })).toBe("t2")
  })

  test("agent returns nothing without live tabs", () => {
    expect(chooseAgentTabId({ tabIds: [], selectedTabId: "t1", otherPinnedTabIds: [] })).toBeUndefined()
  })

  test("I3 fail-closed: no borrow when every live tab is pinned elsewhere", () => {
    expect(
      chooseAgentTabId({ tabIds: ["t1", "t2"], selectedTabId: "t1", otherPinnedTabIds: ["t1", "t2"] }),
    ).toBeUndefined()
  })

  test("I3 fail-closed: no borrow without a live selected tab when all are pinned", () => {
    expect(
      chooseAgentTabId({ tabIds: ["t1", "t2"], selectedTabId: undefined, otherPinnedTabIds: ["t1", "t2"] }),
    ).toBeUndefined()
  })

  test("R1 NO_AGENT_TAB error carries code, session and recovery", () => {
    const withSession = new NoAgentTabError("ses_abc")
    expect(withSession).toBeInstanceOf(Error)
    expect(withSession.name).toBe("NoAgentTabError")
    expect(withSession.code).toBe("NO_AGENT_TAB")
    expect(withSession.sessionID).toBe("ses_abc")
    expect(withSession.message).toContain("NO_AGENT_TAB")
    expect(withSession.message).toContain("ses_abc")
    expect(withSession.message).toContain("Navegador tab")
    expect(withSession.message).toContain("tabId")
  })

  test("R1 NO_AGENT_TAB error without session stays actionable", () => {
    const withoutSession = new NoAgentTabError(undefined)
    expect(withoutSession.code).toBe("NO_AGENT_TAB")
    expect(withoutSession.sessionID).toBeUndefined()
    expect(withoutSession.message).toContain("NO_AGENT_TAB")
    expect(withoutSession.message).toContain("Navegador tab")
  })
})
