import { describe, expect, test } from "bun:test"
import {
  autoPolicyTestBase,
  converge,
  countRepeats,
  normalizeSignature,
  signatureSimilarity,
} from "./auto-policy"

describe("signature normalization", () => {
  test("spacing and case paraphrase normalizes equal", () => {
    expect(normalizeSignature("  Read   SRC/A.ts ")).toBe(normalizeSignature("read src a ts"))
  })
  test("rounds float noise", () => {
    expect(normalizeSignature("took 1.2344s")).toBe(normalizeSignature("took 1.2345s"))
  })
})

describe("similarity", () => {
  test("identical signatures score 1", () => {
    expect(signatureSimilarity("edit a.ts", "edit a.ts")).toBe(1)
  })
  test("subset scores 1 (overlap coefficient)", () => {
    expect(signatureSimilarity("edit a.ts extra", "edit a.ts")).toBe(1)
  })
  test("unrelated actions score low", () => {
    expect(signatureSimilarity("edit parser.ts", "run billing migration")).toBeLessThan(0.9)
  })
})

describe("S1 mechanical loop", () => {
  test("three near-identical repeats stop the loop", () => {
    const signature = "bash: bun test parser"
    const recent = ["bash:  bun   test PARSER", "bash: bun test parser ", "BASH: bun test parser"]
    expect(countRepeats(signature, recent)).toBeGreaterThanOrEqual(3)
    expect(converge(autoPolicyTestBase({ signature, recentSignatures: recent, idleTurns: 3 }))).toBe(
      "blocked-no-advance",
    )
  })
  test("oscillation A-B-A with cosmetic change still counts", () => {
    const signature = "edit a.ts replace foo"
    const recent = ["EDIT  a.ts replace foo", "edit a.ts replace foo!", "edit a.ts replace foo?"]
    expect(
      converge(autoPolicyTestBase({ signature, recentSignatures: recent, idleTurns: 3 })),
    ).toBe("blocked-no-advance")
  })
})

describe("S2 stalls without external change", () => {
  test("creative loop with no diff/tests/effects stops by S2 alone", () => {
    expect(
      converge(
        autoPolicyTestBase({
          signature: "thinking about poem verse one",
          recentSignatures: ["totally different line", "another unrelated line"],
          diffChanged: false,
          checklistAdvanced: false,
          idleTurns: 3,
          staleChecklistTurns: 3,
        }),
      ),
    ).toBe("blocked-no-advance")
  })
  test("long task with real diff keeps progressing", () => {
    const verdicts = [1, 2, 3, 4, 5].map((turn) =>
      converge(autoPolicyTestBase({ turn, diffChanged: turn % 2 === 0, idleTurns: 0 })),
    )
    expect(verdicts.every((v) => v === "progress")).toBe(true)
  })
})

describe("solo-chat countable rule", () => {
  test("five idle chat turns stop without any LLM judge", () => {
    expect(
      converge(
        autoPolicyTestBase({
          chatMode: true,
          diffChanged: false,
          toolWithEffect: false,
          userQuestioned: false,
          idleTurns: 5,
        }),
      ),
    ).toBe("blocked-no-advance")
  })
  test("chat that asks the user keeps going", () => {
    expect(
      converge(autoPolicyTestBase({ chatMode: true, userQuestioned: true, idleTurns: 4 })),
    ).toBe("progress")
  })
})

describe("hard stops", () => {
  test("budget exhausted by turns", () => {
    expect(converge(autoPolicyTestBase({ turn: 30, maxTurns: 30 }))).toBe("blocked-budget")
  })
  test("budget exhausted by tokens", () => {
    expect(converge(autoPolicyTestBase({ tokensOk: false }))).toBe("blocked-budget")
  })
  test("user input wins immediately", () => {
    expect(converge(autoPolicyTestBase({ userInput: true }))).toBe("blocked-user")
  })
  test("unresolved permission pauses", () => {
    expect(converge(autoPolicyTestBase({ permissionPending: true }))).toBe("blocked-permission")
  })
  test("same error three times stops", () => {
    expect(converge(autoPolicyTestBase({ sameErrorStreak: 3 }))).toBe("blocked-user")
  })
  test("external completion completes", () => {
    expect(converge(autoPolicyTestBase({ externalComplete: true }))).toBe("complete")
  })
})
