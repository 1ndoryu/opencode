import { describe, expect, test } from "bun:test"
import { resolveAgentURL, resolveBrowserURL } from "./browser-policy"

describe("browser policy", () => {
  test("agent navigation allows public http(s)", () => {
    expect(resolveAgentURL("https://example.com/a?b=c")).toBe("https://example.com/a?b=c")
    expect(resolveAgentURL("http://example.com")).toBe("http://example.com/")
  })

  test("agent navigation allows localhost dev preview", () => {
    expect(resolveAgentURL("http://localhost:5173/")).toBe("http://localhost:5173/")
    expect(resolveAgentURL("http://app.localhost/")).toBe("http://app.localhost/")
    expect(resolveAgentURL("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/")
    expect(resolveAgentURL("http://[::1]:3000/")).toBe("http://[::1]:3000/")
  })

  test("agent navigation blocks private and link-local", () => {
    expect(resolveAgentURL("http://10.0.0.5/")).toBeUndefined()
    expect(resolveAgentURL("http://172.16.0.9/")).toBeUndefined()
    expect(resolveAgentURL("http://172.31.255.1/")).toBeUndefined()
    expect(resolveAgentURL("http://192.168.1.1/")).toBeUndefined()
    expect(resolveAgentURL("http://169.254.169.254/")).toBeUndefined()
    expect(resolveAgentURL("http://[fe80::1]/")).toBeUndefined()
    expect(resolveAgentURL("http://[fc00::1]/")).toBeUndefined()
    // 172.32 is public, not 172.16/12: must stay allowed
    expect(resolveAgentURL("http://172.32.0.1/")).toBe("http://172.32.0.1/")
  })

  test("agent navigation rejects non-http(s)", () => {
    expect(resolveAgentURL("file:///tmp/index.html")).toBeUndefined()
    expect(resolveAgentURL("javascript:alert(1)")).toBeUndefined()
    expect(resolveAgentURL("not a url")).toBeUndefined()
  })

  test("user address bar still allows localhost", () => {
    expect(resolveBrowserURL("http://localhost:5173/")).toBe("http://localhost:5173/")
  })
})
