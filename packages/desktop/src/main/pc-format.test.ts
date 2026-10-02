import { describe, expect, test } from "bun:test"
import { buildActPayload, buildAuditLine, isOwnWindow, isPcKillActive, isSessionEndedError, parseDesktopShot, parseElements, parsePermissions, parseSnapshot, parseWindows, resolveOpenTarget, runDriver, PC_CALL_TIMEOUT_MS } from "./pc-format"

describe("pc windows", () => {
  test("parses driver list_windows output", () => {
    expect(
      parseWindows({
        windows: [
          {
            pid: 20912,
            window_id: 592486,
            process_name: "TpvNet",
            title: "MENÚ GENERAL",
            visible: true,
            active: false,
            bounds: { x: 0, y: 0, w: 800, h: 600 },
          },
        ],
      }),
    ).toEqual([
      {
        pid: 20912,
        windowId: 592486,
        processName: "TpvNet",
        title: "MENÚ GENERAL",
        visible: true,
        active: false,
        bounds: { x: 0, y: 0, w: 800, h: 600 },
      },
    ])
  })

  test("coerces missing fields instead of throwing", () => {
    expect(parseWindows({ windows: [{}] })).toEqual([
      {
        pid: 0,
        windowId: 0,
        processName: "",
        title: "",
        visible: true,
        active: false,
        bounds: { x: 0, y: 0, w: 0, h: 0 },
      },
    ])
  })

  test("returns empty on non-object input", () => {
    expect(parseWindows(undefined)).toEqual([])
    expect(parseWindows({ windows: "nope" })).toEqual([])
  })
})

describe("pc elements", () => {
  test("parses driver elements", () => {
    expect(
      parseElements({ elements: [{ element_index: 3, role: "Button", label: "Siete", element_token: "s00000002:3" }] }),
    ).toEqual([{ index: 3, role: "Button", label: "Siete", token: "s00000002:3" }])
  })

  test("missing element_token parses as empty, never as the index", () => {
    expect(parseElements({ elements: [{ element_index: 3, role: "Button", label: "Siete" }] })).toEqual([
      { index: 3, role: "Button", label: "Siete", token: "" },
    ])
  })

  test("empty for windows without automation peers", () => {
    expect(parseElements({ elements: [] })).toEqual([])
    expect(parseElements({})).toEqual([])
  })
})

describe("pc captures", () => {
  test("desktop shot requires an image", () => {
    expect(() =>
      parseDesktopShot({ capture_id: "c", screenshot_width: 768, screenshot_height: 512 }),
    ).toThrow("no image")
    expect(
      parseDesktopShot({
        capture_id: "c",
        screenshot_width: 768,
        screenshot_height: 512,
        screenshot_png_b64: "aGVsbG8=",
      }),
    ).toEqual({ captureId: "c", width: 768, height: 512, pngBase64: "aGVsbG8=" })
  })

  test("snapshot carries pid and window id", () => {
    expect(
      parseSnapshot(
        {
          title: "Calculadora",
          capture_id: "c",
          screenshot_width: 402,
          screenshot_height: 667,
          screenshot_png_b64: "aGVsbG8=",
          elements: [{ element_index: 1, role: "Text", label: "Se muestra 42", element_token: "s00000002:1" }],
        },
        14208,
        3279248,
      ),
    ).toEqual({
      pid: 14208,
      windowId: 3279248,
      title: "Calculadora",
      captureId: "c",
      width: 402,
      height: 667,
      pngBase64: "aGVsbG8=",
      elements: [{ index: 1, role: "Text", label: "Se muestra 42", token: "s00000002:1" }],
    })
  })
})

describe("pc permissions", () => {
  test("parses elevation state", () => {
    expect(parsePermissions({ elevated: true, integrity_level: "High", uia: true })).toEqual({
      elevated: true,
      integrityLevel: "High",
      uia: true,
    })
    expect(parsePermissions({})).toEqual({ elevated: false, integrityLevel: "unknown", uia: false })
  })
})

describe("pc open allowlist", () => {
  test("resolves the three v1 apps, rejects everything else", () => {
    expect(resolveOpenTarget({ target: "calculadora" })).toEqual({ kind: "aumid", aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" })
    expect(resolveOpenTarget({ target: "notepad" })).toEqual({ kind: "aumid", aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" })
    expect(resolveOpenTarget({ target: "explorer" })).toEqual({ kind: "name", name: "Explorer" })
    expect(() => resolveOpenTarget({ target: "C:\\Windows\\System32\\calc.exe" })).toThrow("refused")
    expect(() => resolveOpenTarget({ target: "https://example.com" })).toThrow("refused")
    expect(() => resolveOpenTarget({ target: "tpvnet" })).toThrow("refused")
  })
})

describe("pc anti-own", () => {
  const self = { pid: 100, names: ["opencode-propio", "opencode"] }
  test("matches own pid and own names, ignores third-party apps", () => {
    expect(isOwnWindow({ pid: 100, processName: "whatever", title: "x" }, self)).toBe(true)
    expect(isOwnWindow({ pid: 200, processName: "opencode-propio", title: "Dev" }, self)).toBe(true)
    expect(isOwnWindow({ pid: 20912, processName: "TpvNet", title: "MENÚ GENERAL" }, self)).toBe(false)
    expect(isOwnWindow({ pid: 21752, processName: "CalculatorApp", title: "Calculadora" }, self)).toBe(false)
  })

  test("refuses windows showing localhost dev servers", () => {
    expect(isOwnWindow({ pid: 300, processName: "chrome", title: "localhost:4096 - OpenCode" }, self)).toBe(true)
    expect(isOwnWindow({ pid: 301, processName: "WindowsTerminal", title: "http://127.0.0.1:4444/" }, self)).toBe(true)
  })
})

describe("pc act payload", () => {
  test("click drops injection fields and defaults to background", () => {
    expect(
      buildActPayload("click", {
        pid: 21752,
        window_id: 3279248,
        action: "click",
        element_token: "abc",
        x: 10,
        y: 20,
        launch_path: "evil.exe",
        screen: { x: 0, y: 0 },
      }),
    ).toEqual({ pid: 21752, window_id: 3279248, delivery_mode: "background", element_token: "abc" })
  })

  test("click without token requires x + y", () => {
    expect(() => buildActPayload("click", { pid: 1, window_id: 2 })).toThrow("element_token or x + y")
    expect(buildActPayload("click", { pid: 1, window_id: 2, x: 5, y: 6 })).toEqual({
      pid: 1,
      window_id: 2,
      delivery_mode: "background",
      x: 5,
      y: 6,
    })
  })

  test("type_text rejects empty text, scroll rejects bad direction", () => {
    expect(() => buildActPayload("type_text", { pid: 1, window_id: 2, text: "" })).toThrow("needs text")
    expect(() => buildActPayload("scroll", { pid: 1, window_id: 2, direction: "diagonal" })).toThrow("needs direction")
    expect(buildActPayload("scroll", { pid: 1, window_id: 2, direction: "down" })).toEqual({
      target: { kind: "window", pid: 1, window_id: 2 },
      direction: "down",
      delivery_mode: "background",
    })
  })
})

describe("pc kill-switch", () => {
  test("env flag or kill file activates it, nothing else does", () => {
    expect(isPcKillActive("1", false)).toBe(true)
    expect(isPcKillActive(undefined, true)).toBe(true)
    expect(isPcKillActive("1", true)).toBe(true)
    expect(isPcKillActive(undefined, false)).toBe(false)
    expect(isPcKillActive("0", false)).toBe(false)
    expect(isPcKillActive("", false)).toBe(false)
  })
})

describe("pc audit line", () => {
  test("carries what/where/when/session but never typed text", () => {
    const parsed = JSON.parse(
      buildAuditLine({ method: "act:type_text", pid: 1, windowId: 2, action: "type", chars: 8, session: "opencode-pc" }),
    )
    expect(parsed.method).toBe("act:type_text")
    expect(parsed.pid).toBe(1)
    expect(parsed.windowId).toBe(2)
    expect(parsed.chars).toBe(8)
    expect(parsed.session).toBe("opencode-pc")
    expect(typeof parsed.ts).toBe("string")
    expect("text" in parsed).toBe(false)
  })
})

describe("pc driver timeout", () => {
  test("the call budget is 30s", () => {
    expect(PC_CALL_TIMEOUT_MS).toBe(30_000)
  })

  test("a hung driver call is killed after the timeout", async () => {
    const start = Date.now()
    await expect(runDriver(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {}, 300)).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(8000)
  })

  test("a fast call resolves with its stdout", async () => {
    await expect(runDriver(process.execPath, ["-e", "process.stdout.write('{}')"], {})).resolves.toBe("{}")
  })
})

describe("pc session lifecycle", () => {
  async function failedCall(script: string): Promise<unknown> {
    try {
      await runDriver(process.execPath, ["-e", script], {})
      return "no-throw"
    } catch (error) {
      return error
    }
  }

  test("flags the driver's ended-session stderr", async () => {
    const error = await failedCall("process.stderr.write(\"session has ended; tool call 'x' was rejected.\");process.exit(1)")
    expect(isSessionEndedError(error)).toBe(true)
  })

  test("ordinary driver failures are not session ends", async () => {
    const error = await failedCall("process.stderr.write('Command failed: boom');process.exit(1)")
    expect(isSessionEndedError(error)).toBe(false)
    expect(isSessionEndedError(new Error("stale_element_token"))).toBe(false)
    expect(isSessionEndedError("session has ended")).toBe(true)
  })
})
