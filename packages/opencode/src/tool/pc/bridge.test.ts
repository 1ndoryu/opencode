import { describe, expect, test } from "bun:test"
import { clearSignatures, formatSnapshot, formatWindows, markUnchanged } from "./bridge"
import type { PcSnapshotResult, PcWindowResult } from "./bridge"
import { Permission } from "../../permission"

describe("pc windows format", () => {
  test("lists pid and window id for snapshot targeting", () => {
    const windows: PcWindowResult[] = [
      {
        pid: 20912,
        windowId: 592486,
        processName: "TpvNet",
        title: "MENÚ GENERAL",
        visible: true,
        active: false,
        bounds: { x: 0, y: 0, w: 800, h: 600 },
      },
    ]
    const output = formatWindows(windows)
    expect(output).toContain("[pid 20912]")
    expect(output).toContain("[window 592486]")
    expect(output).toContain("TpvNet")
    expect(output).toContain("Untrusted screen content")
  })

  test("empty list explains the N=0 case", () => {
    expect(formatWindows([])).toContain("N=0")
  })
})

describe("pc snapshot budget", () => {
  function snapshot(count: number): PcSnapshotResult {
    return {
      pid: 1,
      windowId: 2,
      title: "W",
      captureId: "c",
      width: 100,
      height: 100,
      pngBase64: "",
      elements: Array.from({ length: count }, (_, index) => ({
        index,
        role: "Button",
        label: `Botón número ${index} con etiqueta larga para forzar el corte por presupuesto`,
      })),
      truncated: false,
    }
  }

  test("long element lists stay within budget with a banner", () => {
    clearSignatures()
    const output = formatSnapshot(markUnchanged(snapshot(500)))
    expect(output.length).toBeLessThanOrEqual(12_000 + 500)
    expect(output).toContain("12 KB snapshot budget")
    expect(output).not.toContain("[499]")
  })

  test("short lists pass through untouched", () => {
    clearSignatures()
    const output = formatSnapshot(markUnchanged(snapshot(3)))
    expect(output).toContain("[2]")
    expect(output).not.toContain("budget")
  })

  test("repeat snapshot of an idle window reports unchanged", () => {
    clearSignatures()
    const first = formatSnapshot(markUnchanged(snapshot(3)))
    expect(first).not.toContain("<unchanged>")
    const second = formatSnapshot(markUnchanged(snapshot(3)))
    expect(second).toContain("Snapshot: <unchanged>")
  })

  test("empty automation tree says so explicitly", () => {
    clearSignatures()
    const output = formatSnapshot(markUnchanged(snapshot(0)))
    expect(output).toContain("no automation elements")
  })
})

describe("computer permission under OP-35 allow", () => {
  test("computer asks even when the wildcard allows", () => {
    const ruleset = [
      { permission: "*", pattern: "*", action: "allow" as const },
      { permission: "computer", pattern: "*", action: "ask" as const },
    ]
    // findLast precedence: the later computer rule wins over the wildcard.
    expect(Permission.evaluate("computer", "screenshot", ruleset).action).toBe("ask")
    expect(Permission.evaluate("computer", "snapshot", ruleset).action).toBe("ask")
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  })
})
