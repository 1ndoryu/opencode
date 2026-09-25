import { describe, expect, test } from "bun:test"
import {
  THREAD_TAIL_SCRIPT,
  isMarketplaceUrl,
  parseThreadTail,
  signatureFor,
  threadKeyFor,
} from "./marketplace-watch"

describe("isMarketplaceUrl", () => {
  test("accepts www, mobile and bare facebook marketplace pages", () => {
    expect(isMarketplaceUrl("https://www.facebook.com/marketplace/inbox/?targetTab=SELLER")).toBe(true)
    expect(isMarketplaceUrl("https://m.facebook.com/marketplace/123456789")).toBe(true)
    expect(isMarketplaceUrl("https://facebook.com/marketplace/inbox")).toBe(true)
    expect(isMarketplaceUrl("HTTPS://WWW.FACEBOOK.COM/MARKETPLACE/INBOX")).toBe(true)
  })
  test("rejects non-marketplace and lookalike hosts", () => {
    expect(isMarketplaceUrl("https://www.facebook.com/")).toBe(false)
    expect(isMarketplaceUrl("https://www.facebook.com/messages/")).toBe(false)
    expect(isMarketplaceUrl("https://www.facebook.com.evil.com/marketplace/inbox")).toBe(false)
    expect(isMarketplaceUrl("https://www.facebookmarketplace.com/")).toBe(false)
    expect(isMarketplaceUrl("about:blank")).toBe(false)
    expect(isMarketplaceUrl("")).toBe(false)
  })
})

describe("threadKeyFor", () => {
  test("combines url and buyer title, trims and caps the title", () => {
    const key = threadKeyFor(
      "https://www.facebook.com/marketplace/inbox/?thread=1",
      "  Edgar   ·   Casa Riberas del Caroní  ",
    )
    expect(key).toBe(
      "https://www.facebook.com/marketplace/inbox/?thread=1|Edgar · Casa Riberas del Caroní",
    )
  })
  test("caps long titles so keys stay bounded", () => {
    const key = threadKeyFor("https://www.facebook.com/marketplace/inbox", "x".repeat(200))
    expect(key.endsWith("x".repeat(120))).toBe(true)
  })
})

describe("signatureFor", () => {
  test("is stable for identical input and moves on any change", () => {
    expect(signatureFor("Edgar", "Precio")).toBe(signatureFor("Edgar", "Precio"))
    expect(signatureFor("Edgar", "Precio")).not.toBe(signatureFor("Edgar", "¿Sigue disponible?"))
    expect(signatureFor("Edgar", "Precio")).not.toBe(signatureFor("Jose", "Precio"))
    expect(signatureFor("", "")).toBe(signatureFor("", ""))
  })
})

describe("parseThreadTail", () => {
  test("accepts the guest script shape", () => {
    expect(parseThreadTail({ title: "Edgar · Casa", tail: "Precio" })).toEqual({
      title: "Edgar · Casa",
      tail: "Precio",
    })
  })
  test("rejects anything else so a silent page is skipped, not shown", () => {
    expect(parseThreadTail(null)).toBeNull()
    expect(parseThreadTail([])).toBeNull()
    expect(parseThreadTail({ title: "Edgar" })).toBeNull()
    expect(parseThreadTail({ title: 1, tail: "x" })).toBeNull()
    expect(parseThreadTail("Precio")).toBeNull()
  })
})

describe("THREAD_TAIL_SCRIPT", () => {
  test("reads title plus visible text tail without touching the network", () => {
    expect(THREAD_TAIL_SCRIPT).toContain("document.title")
    expect(THREAD_TAIL_SCRIPT).toContain("innerText")
    expect(THREAD_TAIL_SCRIPT).not.toContain("fetch")
    expect(THREAD_TAIL_SCRIPT).not.toContain("XMLHttpRequest")
  })
})
