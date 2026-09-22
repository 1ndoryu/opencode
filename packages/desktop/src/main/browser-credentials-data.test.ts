import { describe, expect, test } from "bun:test"
import { hostOf, matchEntry, mergeEntries, parseChromeCsv, parseCsv } from "./browser-credentials-data"

describe("chrome csv parser", () => {
  test("parses plain rows", () => {
    const entries = parseChromeCsv(
      "name,url,username,password\ncontabo,https://my.contabo.com/,user@example.com,s3cret\n",
    )
    expect(entries).toEqual([{ name: "contabo", url: "https://my.contabo.com/", username: "user@example.com", password: "s3cret" }])
  })

  test("handles quotes, commas and escaped quotes", () => {
    const entries = parseChromeCsv(
      'name,url,username,password\n"my, site",https://example.com/,"quoted""user",p,a"ss\n',
    )
    expect(entries[0]?.name).toBe("my, site")
    expect(entries[0]?.username).toBe('quoted"user')
  })

  test("rejects a non-chrome header", () => {
    expect(() => parseChromeCsv("a,b,c\n1,2,3\n")).toThrow("Not a Chrome password export")
  })

  test("skips rows without url, username or password", () => {
    const entries = parseChromeCsv("name,url,username,password\nx,,user,pw\ny,https://e.com/,,\n")
    expect(entries).toEqual([])
  })

  test("parses CRLF without phantom rows", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })
})

describe("credential merge and match", () => {
  test("re-import is idempotent and updates passwords", () => {
    const stored = [{ name: "a", url: "https://e.com/", username: "u", password: "old" }]
    const merged = mergeEntries(stored, [{ name: "a", url: "https://e.com/", username: "u", password: "new" }])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.password).toBe("new")
  })

  test("exact host wins over parent suffix", () => {
    const entries = [
      { name: "", url: "https://contabo.com/", username: "root", password: "p1" },
      { name: "", url: "https://my.contabo.com/", username: "user", password: "p2" },
    ]
    expect(matchEntry(entries, "https://my.contabo.com/login")?.password).toBe("p2")
    expect(matchEntry(entries, "https://new.contabo.com/")?.password).toBe("p1")
    expect(matchEntry(entries, "https://other.com/")).toBeUndefined()
  })

  test("hostOf lowercases", () => {
    expect(hostOf("https://My.Contabo.COM/x")).toBe("my.contabo.com")
    expect(hostOf("not a url")).toBeUndefined()
  })
})
