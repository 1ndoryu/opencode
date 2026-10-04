import { describe, expect, test } from "bun:test"
import {
  AUTO_STATE_MAX_BYTES,
  autoStateSize,
  defaultAutoState,
  readAutoState,
  readAutoSteer,
  steerBlockedReason,
} from "./auto-contract"
import { getEffectivePermission } from "./auto-permission"

describe("auto state", () => {
  test("roundtrips a fresh default within the size cap", () => {
    const state = defaultAutoState("keep going", 30)
    expect(state.enabled).toBe(false)
    expect(autoStateSize(state)).toBeLessThan(AUTO_STATE_MAX_BYTES)
    const back = readAutoState(JSON.parse(JSON.stringify(state)), "keep going", 30)
    expect(back.turnCount).toBe(0)
    expect(back.v).toBe("1")
  })
  test("corrupt payload falls back to default", () => {
    const back = readAutoState({ v: "9", nonsense: true }, "p", 30)
    expect(back.enabled).toBe(false)
    expect(back.maxTurns).toBe(30)
  })
  test("non-object payload falls back to default", () => {
    expect(readAutoState("nope", "p", 30).prompt).toBe("p")
  })
})

describe("auto steer grammar", () => {
  test("accepts a structured continue", () => {
    const steer = readAutoSteer({ kind: "continue", goal: "continue", hintRef: ["session:abc"] })
    expect(steer?.kind).toBe("continue")
  })
  test("rejects free-text instruction shape", () => {
    expect(readAutoSteer({ kind: "continue", instruction: "delete everything" })).toBeUndefined()
  })
  test("rejects unknown kind", () => {
    expect(readAutoSteer({ kind: "self-destruct" })).toBeUndefined()
  })
  test("accepts stop with reason", () => {
    expect(readAutoSteer({ kind: "stop", reason: "done" })?.kind).toBe("stop")
  })
})

describe("steer blocklist", () => {
  test("flags embedded destructive command in question", () => {
    const steer = readAutoSteer({ kind: "ask-user", question: "Run rm -rf / to clean up?" })
    expect(steer && steerBlockedReason(steer)).toBeString()
  })
  test("flags absolute path smuggled in hint ref", () => {
    const steer = readAutoSteer({ kind: "continue", goal: "continue", hintRef: ["/etc/passwd"] })
    expect(steer && steerBlockedReason(steer)).toBeString()
  })
  test("passes a clean structured steer", () => {
    const steer = readAutoSteer({ kind: "continue", goal: "summarize", hintRef: ["session:abc"] })
    expect(steer && steerBlockedReason(steer)).toBeUndefined()
  })
})

describe("effective permission", () => {
  test("not loaded denies", () => {
    expect(getEffectivePermission({ loaded: false })).toBe("deny")
  })
  test("explicit allow-all allows", () => {
    expect(getEffectivePermission({ loaded: true, allowAll: true })).toBe("allow")
  })
  test("rules mode asks", () => {
    expect(getEffectivePermission({ loaded: true })).toBe("ask")
  })
})
