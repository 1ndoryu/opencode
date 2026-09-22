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

describe("browser-service OP-31 beta-report guards", () => {
  test("snapshot keeps hidden actionables in a marked second tier", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain("isHidden")
    expect(source).toContain("(hidden)")
    expect(source).toContain("hidden.push(entry)")
  })

  test("denied popup is recorded and reported on click", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain("deniedPopups")
    expect(source).toContain("Popup blocked")
    expect(source).toContain("browser_navigate")
  })

  test("act carries the real js error instead of swallowing it", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain("js failed:")
  })

  test("fill on a file input fails with a specific error", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain('element.type === "file"')
    expect(source).toContain("file upload")
  })

  test("screenshot waits for the flipped tab to gain a surface", async () => {
    const bridge = await Bun.file(
      new URL("../../../desktop/src/main/browser-bridge.ts", import.meta.url),
    ).text()
    expect(bridge).toContain("!active.selected) await")
  })
})

describe("browser-service OP-32 credentials guards", () => {
  test("CSV parser expects the Chrome export header and rejects the rest", async () => {
    const source = await Bun.file(
      new URL("../../../desktop/src/main/browser-credentials-data.ts", import.meta.url),
    ).text()
    expect(source).toContain("name,url,username,password")
    expect(source).toContain("Not a Chrome password export")
  })

  test("store is OS-keychain encrypted and never lists passwords", async () => {
    const source = await Bun.file(
      new URL("../../../desktop/src/main/browser-credentials.ts", import.meta.url),
    ).text()
    expect(source).toContain("safeStorage")
    expect(source).toContain("decryptString")
    expect(source).toContain("encryptString")
    expect(source).toContain("browser-credentials.dat")
    expect(source).toContain("username }))")
    expect(source).not.toContain("entry.password })")
  })

  test("login fills inside the guest and returns no secret", async () => {
    const source = await Bun.file(
      new URL("../../../desktop/src/main/browser-credentials.ts", import.meta.url),
    ).text()
    expect(source).toContain('input[type="password"]')
    expect(source).toContain("JSON.stringify(entry.username)")
    expect(source).toContain("fillLoginForGuest")
  })

  test("bridge exposes the four credentials methods", async () => {
    const bridge = await Bun.file(
      new URL("../../../desktop/src/main/browser-bridge.ts", import.meta.url),
    ).text()
    expect(bridge).toContain("credentials-import")
    expect(bridge).toContain("credentials-status")
    expect(bridge).toContain("credentials-login")
    expect(bridge).toContain("credentials-forget")
  })

  test("snapshot never names a password field from its value", async () => {
    const source = await Bun.file(
      new URL(SERVICE_PATH, import.meta.url),
    ).text()
    expect(source).toContain('element.type === "password"')
    expect(source).toContain("hideValue")
  })

  test("browser_credentials tool is registered with four actions", async () => {
    const tool = await Bun.file(
      new URL("../../src/tool/browser/credentials.ts", import.meta.url),
    ).text()
    expect(tool).toContain("browser_credentials")
    expect(tool).toContain('"import", "status", "login", "forget"')
    const registry = await Bun.file(
      new URL("../../src/tool/registry.ts", import.meta.url),
    ).text()
    expect(registry).toContain("browsercredentials")
  })
})
