import { describe, expect, test } from "bun:test"
import { parseDesktopShot, parseElements, parsePermissions, parseSnapshot, parseWindows } from "./pc-format"

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
      parseElements({ elements: [{ element_index: 3, role: "Button", label: "Siete" }] }),
    ).toEqual([{ index: 3, role: "Button", label: "Siete" }])
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
          elements: [{ element_index: 1, role: "Text", label: "Se muestra 42" }],
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
      elements: [{ index: 1, role: "Text", label: "Se muestra 42" }],
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
