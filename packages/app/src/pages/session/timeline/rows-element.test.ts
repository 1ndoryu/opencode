import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { createElementMetadata } from "@/utils/element-note"
import { MessageElement } from "./message-element"

function textPart(overrides: Partial<Extract<Part, { type: "text" }>>): Part {
  return {
    id: "prt_test",
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "text",
    text: "Picked <button> element from https://shop.test/p/1:\nselector: button.add",
    synthetic: true,
    metadata: createElementMetadata({
      url: "https://shop.test/p/1",
      selector: "button.add",
      tagName: "button",
    }),
    ...overrides,
  } as Part
}

describe("MessageElement.fromPart", () => {
  test("badges synthetic element text parts with tag, selector and note", () => {
    const found = MessageElement.fromPart(textPart({}))
    expect(found?.tagName).toBe("button")
    expect(found?.selector).toBe("button.add")
    expect(found?.note).toContain("Picked <button> element from https://shop.test/p/1:")
    expect(found?.note).toContain("selector: button.add")
  })

  test("ignores non-synthetic text parts", () => {
    expect(MessageElement.fromPart(textPart({ synthetic: false }))).toBeUndefined()
  })

  test("ignores text parts without element metadata", () => {
    expect(MessageElement.fromPart(textPart({ metadata: {} }))).toBeUndefined()
  })

  test("ignores non-text parts", () => {
    expect(
      MessageElement.fromPart({
        id: "prt_file",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "file",
        mime: "image/png",
        filename: "element.png",
        url: "file:///tmp/element.png",
      } as Part),
    ).toBeUndefined()
  })
})
