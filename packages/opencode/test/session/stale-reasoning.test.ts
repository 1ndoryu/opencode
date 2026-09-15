import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "../../src/session/llm/request"

const staleMessage =
  "Upstream request failed: [invalid_request_error] reasoning `encrypted_content` was not issued to this caller"

function assistantContent(message: ModelMessage) {
  if (message.role !== "assistant") throw new Error("expected assistant message")
  if (!Array.isArray(message.content)) throw new Error("expected array content")
  return message.content
}

describe("session.llm.staleReasoning", () => {
  test("detects blobs issued to another caller", () => {
    expect(LLMRequestPrep.isStaleReasoningError(new Error(staleMessage))).toBe(true)
  })

  test("reads plain failure values", () => {
    expect(LLMRequestPrep.isStaleReasoningError({ message: staleMessage })).toBe(true)
  })

  test("ignores unrelated upstream failures", () => {
    expect(LLMRequestPrep.isStaleReasoningError(new Error("Upstream request failed: over capacity"))).toBe(false)
    expect(LLMRequestPrep.isStaleReasoningError(new Error("reasoning `encrypted_content` is malformed"))).toBe(false)
    expect(LLMRequestPrep.isStaleReasoningError(new Error("boom"))).toBe(false)
  })

  test("keeps clean histories untouched", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    expect(LLMRequestPrep.stripStaleReasoning(messages)).toBe(messages)
  })

  test("drops only the blob and preserves replay shape", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "let me think",
            providerOptions: { openai: { reasoningEncryptedContent: "stale-blob", itemId: "rs_1" } },
          },
          { type: "text", text: "answer" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "x" } },
        ],
      },
    ]
    const stripped = LLMRequestPrep.stripStaleReasoning(messages)
    expect(stripped).not.toBe(messages)
    expect(stripped[0]).not.toBe(messages[0])
    expect(stripped).toEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "let me think", providerOptions: { openai: { itemId: "rs_1" } } },
          { type: "text", text: "answer" },
          { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "x" } },
        ],
      },
    ])
    // Untouched parts keep their identity so the retry reuses the same chain.
    const before = assistantContent(messages[0])
    const after = assistantContent(stripped[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  test("removes holders left empty after stripping", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "thinking", providerOptions: { openai: { reasoningEncryptedContent: "x" } } }],
      },
    ]
    expect(LLMRequestPrep.stripStaleReasoning(messages)).toEqual([
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
    ])
  })

  test("strips legacy providerMetadata blobs", () => {
    // Stored parts predate the providerOptions-only ModelMessage type, so the
    // legacy holder rides along untyped at runtime. Built outside the message
    // literal so excess-property checking does not reject the runtime shape.
    const legacyReasoning: { type: "reasoning"; text: string } = { type: "reasoning", text: "legacy" }
    const legacyWithMetadata = {
      ...legacyReasoning,
      providerMetadata: { openai: { reasoningEncryptedContent: "x" } },
    }
    const messages: ModelMessage[] = [{ role: "assistant", content: [legacyWithMetadata] }]
    expect(LLMRequestPrep.stripStaleReasoning(messages)).toEqual([
      { role: "assistant", content: [{ type: "reasoning", text: "legacy" }] },
    ])
  })
})
