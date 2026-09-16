import { describe, expect, test } from "bun:test"
import { formatSnapshot } from "../../src/tool/browser/bridge"
import type { BrowserSnapshotResult } from "../../src/tool/browser/bridge"

// OP-21 F0: deterministic benchmark of what the model actually sees —
// formatSnapshot output chars for a dense 150-node page vs a small one.
// The same fixture measures before/after across F1 (compact) and F2 (budget).

const ROLES = ["link", "button", "textbox", "combobox", "checkbox", "menuitem"] as const

function denseSelector(i: number): string {
  return (
    `body > div:nth-of-type(${(i % 5) + 1}) > div:nth-of-type(${(i % 7) + 1}) > ` +
    `ul:nth-of-type(${(i % 3) + 1}) > li:nth-of-type(${(i % 11) + 1}) > ` +
    `div:nth-of-type(${(i % 4) + 1}) > div:nth-of-type(${(i % 6) + 1}) > a`
  )
}

function denseName(i: number): string {
  if (i % 3 === 0) return `Action item number ${i} with some descriptive accessible text`
  if (i % 3 === 1) return `Me gusta · ${i}`
  return "OK"
}

function denseSnapshot(): BrowserSnapshotResult {
  return {
    attached: true,
    tabId: "t1",
    title: "Facebook",
    url: "https://www.facebook.com/",
    nodes: Array.from({ length: 150 }, (_, i) => ({
      ref: i,
      role: ROLES[i % ROLES.length],
      name: denseName(i),
      selector: denseSelector(i),
      depth: i % 6,
    })),
    truncated: true,
  }
}

function smallSnapshot(): BrowserSnapshotResult {
  return {
    attached: true,
    tabId: "t1",
    title: "Login",
    url: "https://example.com/login",
    nodes: Array.from({ length: 8 }, (_, i) => ({
      ref: i,
      role: i % 2 === 0 ? "textbox" : "button",
      name: i % 2 === 0 ? `field ${i}` : "Sign in",
      selector: `body > form > input:nth-of-type(${i + 1})`,
      depth: Math.min(i, 2),
    })),
    truncated: false,
  }
}

describe("browser snapshot budget (OP-21 F0)", () => {
  test("dense fixture measures the current format", () => {
    const output = formatSnapshot(denseSnapshot())
    console.log(`[F0] dense 150 nodes: ${output.length} chars, ${output.split("\n").length} lines`)
    expect(denseSnapshot().nodes).toHaveLength(150)
    expect(output.length).toBeGreaterThan(0)
  })

  test("small fixture stays intact", () => {
    const output = formatSnapshot(smallSnapshot())
    console.log(`[F0] small 8 nodes: ${output.length} chars`)
    expect(output).toContain("Sign in")
  })

  test("short snapshot has no budget banner (OP-21 F2)", () => {
    const output = formatSnapshot(smallSnapshot())
    expect(output).not.toContain("more nodes hidden")
  })

  test("oversize snapshot is cut with a counted banner (OP-21 F2)", () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({
      ref: i,
      role: "checkbox",
      name: `N${"x".repeat(78)}`,
      selector: denseSelector(i),
      depth: 0,
    }))
    const output = formatSnapshot({
      attached: true,
      tabId: "t1",
      title: "XL",
      url: "https://example.com/xl",
      nodes,
      truncated: false,
    })
    console.log(`[F2] oversize 150 nodes cut: ${output.length} chars`)
    expect(output).toContain("more nodes hidden by the 12 KB snapshot budget")
    expect(output).toContain("[0] checkbox")
    // Node section stays within budget (header lines excluded by design).
    expect(output.length).toBeLessThanOrEqual(12_500)
    const hidden = Number(output.match(/… (\d+) more nodes hidden/)?.[1] ?? "0")
    const kept = output.split("\n").filter((line) => /^\[\d+\] /.test(line)).length
    expect(kept + hidden).toBe(150)
  })

  test("compact format drops selectors and indents by depth (OP-21 F1)", () => {
    const output = formatSnapshot(denseSnapshot())
    console.log(`[F1] dense 150 nodes compact: ${output.length} chars`)
    expect(output).not.toContain("body >")
    expect(output).not.toContain("nth-of-type")
    const lines = output.split("\n")
    expect(lines).toContain(`[0] link "Action item number 0 with some descriptive accessible text"`)
    expect(lines).toContain(`    [2] textbox "OK"`)
  })
})
