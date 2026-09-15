import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { callBrowser, formatSnapshot, formatState, tabParams } from "../../src/tool/browser/bridge"
import type { BrowserPort } from "../../src/tool/browser/bridge"

function adapt(port: MessagePort): BrowserPort {
  port.start()
  return {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => {
      if (event !== "message") return
      port.on("message", (data) => listener({ data }))
    },
  }
}

function respond(port: MessagePort, handler: (request: { id: string; method: string }) => unknown) {
  port.on("message", (data: any) => {
    if (!data || data.type !== "browser-request") return
    port.postMessage({ type: "browser-response", id: data.id, ok: true, result: handler(data) })
  })
}

describe("browser bridge", () => {
  test("fails closed without a sidecar parent port", async () => {
    const error = await Effect.runPromise(callBrowser("state", {}, 1000, undefined).pipe(Effect.flip))
    expect(String(error)).toContain("not attached")
  })

  test("resolves a request over the port", async () => {
    const channel = new MessageChannel()
    respond(channel.port2, () => ({ attached: true, url: "https://example.com/" }))
    try {
      const result = await Effect.runPromise(callBrowser("state", {}, 1000, adapt(channel.port1)))
      expect(result).toEqual({ attached: true, url: "https://example.com/" })
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  test("surfaces bridge errors", async () => {
    const channel = new MessageChannel()
    channel.port2.on("message", (data: any) => {
      channel.port2.postMessage({ type: "browser-response", id: data.id, ok: false, error: "nope" })
    })
    try {
      const error = await Effect.runPromise(callBrowser("state", {}, 1000, adapt(channel.port1)).pipe(Effect.flip))
      expect(String(error)).toContain("nope")
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  test("ignores unrelated messages", async () => {
    const channel = new MessageChannel()
    channel.port2.on("message", (data: any) => {
      channel.port2.postMessage({ type: "unrelated" })
      channel.port2.postMessage({ type: "browser-response", id: data.id, ok: true, result: "fine" })
    })
    try {
      const result = await Effect.runPromise(callBrowser("state", {}, 1000, adapt(channel.port1)))
      expect(result).toBe("fine")
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  test("times out without a responder", async () => {
    const channel = new MessageChannel()
    try {
      const error = await Effect.runPromise(callBrowser("state", {}, 50, adapt(channel.port1)).pipe(Effect.flip))
      expect(String(error)).toContain("timed out")
    } finally {
      channel.port1.close()
      channel.port2.close()
    }
  })

  test("tabParams carries the session and optional tab", () => {
    expect(tabParams("ses-1")).toEqual({ sessionID: "ses-1" })
    expect(tabParams("ses-1", "t2")).toEqual({ sessionID: "ses-1", tabId: "t2" })
  })

  test("state and snapshot echo the tab id", () => {
    expect(formatState({ attached: true, tabId: "t2", title: "T", url: "https://example.com/", loading: false })).toBe(
      "Tab t2\nT\nhttps://example.com/\n[idle]",
    )
    expect(
      formatSnapshot({ attached: true, tabId: "t2", title: "T", url: "https://example.com/", nodes: [], truncated: false }).split("\n").slice(0, 2),
    ).toEqual(["Tab t2", "T"])
    expect(formatState({ attached: true, title: "T", url: "https://example.com/", loading: false }).split("\n")[0]).toBe("T")
  })
})
