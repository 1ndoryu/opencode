import { describe, expect, test } from "bun:test"

// OP-22 guard: the three live failures on wp-login must not regress.
// - depthOf was defined only in PICK_SCRIPT while SNAPSHOT_SCRIPT used it,
//   so every snapshot threw ReferenceError -> caught to null -> empty list.
// - evaluate wrapped js as `(${js})`, killing multi-statement scripts.
// - capturePage UnknownVizError (hidden guest) bubbled raw with no retry.
const SERVICE_PATH = "../../../desktop/src/main/browser-service.ts"

describe("browser-service live-failure guards", () => {
  test("depthOf shared between PICK_SCRIPT and SNAPSHOT_SCRIPT", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain("const DEPTH_FN =")
    const sharedUses = source.split("const depthOf = ${DEPTH_FN}").length - 1
    expect(sharedUses).toBeGreaterThanOrEqual(2)
    expect(source).toContain("depth: depthOf(current)")
  })

  test("evaluate supports statement lists via expression-first fallback", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain("new AsyncFn")
    expect(source).toContain("instanceof SyntaxError")
  })

  test("capture retries once and reports no-surface actionably", async () => {
    const service = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(service).toContain("tryCapturePage")
    expect(service).toContain("CAPTURE_RETRY_MS")
    const bridge = await Bun.file(
      new URL("../../../desktop/src/main/browser-bridge.ts", import.meta.url),
    ).text()
    expect(bridge).toContain("no display surface")
  })
})
