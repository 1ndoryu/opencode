import { describe, expect, test } from "bun:test"
import { createElementMetadata, formatElementNote, readElementMetadata } from "./element-note"

describe("formatElementNote", () => {
  test("skips empty optional fields", () => {
    const text = formatElementNote({
      url: "https://shop.test/p/1",
      selector: "button.add",
      tagName: "button",
    })

    expect(text).toBe("Picked <button> element from https://shop.test/p/1:\nselector: button.add")
  })

  test("includes every populated field in order", () => {
    const text = formatElementNote({
      url: "https://shop.test/p/1",
      selector: "button.add",
      tagName: "button",
      xpath: "/HTML/BODY[1]/BUTTON[1]",
      role: "button",
      label: "Añadir",
      text: "Añadir",
      attributes: { class: "add", "data-id": "42" },
      outerHtml: '<button class="add">Añadir</button>',
    })

    expect(text.split("\n")).toEqual([
      "Picked <button> element from https://shop.test/p/1:",
      "selector: button.add",
      "xpath: /HTML/BODY[1]/BUTTON[1]",
      "role: button",
      "label: Añadir",
      "text: Añadir",
      'attributes: class="add" data-id="42"',
      'html: <button class="add">Añadir</button>',
    ])
  })
})

describe("element metadata", () => {
  test("round-trips through create and read", () => {
    const input = {
      url: "https://shop.test/p/1",
      selector: "button.add",
      tagName: "button",
      xpath: "/HTML/BODY[1]/BUTTON[1]",
      attributes: { class: "add" },
    }

    expect(readElementMetadata(createElementMetadata(input))).toEqual({
      ...input,
      role: undefined,
      label: undefined,
      text: undefined,
      outerHtml: undefined,
    })
  })

  test("rejects payloads without url, selector, and tagName", () => {
    expect(readElementMetadata({ opencodeElement: { selector: "a" } })).toBeUndefined()
    expect(readElementMetadata(undefined)).toBeUndefined()
  })
})
