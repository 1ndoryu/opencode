import { Effect } from "effect"

// Request/response client for the Desktop browser tab. Tools run inside the
// sidecar server process; when that server was spawned by Desktop it has an
// Electron parentPort back to main, where the <webview> guest lives. Under
// CLI/TUI there is no parent and every call fails closed with a plain message.
export type BrowserPort = {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

export type BrowserStateResult = {
  attached: boolean
  url?: string
  title?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

export type BrowserSnapshotResult = BrowserStateResult & {
  nodes: { ref: number; role: string; name: string; selector: string }[]
  truncated: boolean
}

export type BrowserConsoleResult = BrowserStateResult & {
  entries: { level: string; message: string; line: number; sourceId: string; ts: number }[]
}

const listened = new WeakSet<object>()
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
let seq = 0

function defaultPort(): BrowserPort | undefined {
  const port = (process as unknown as { parentPort?: BrowserPort }).parentPort
  if (!port || typeof port.postMessage !== "function" || typeof port.on !== "function") return undefined
  return port
}

function ensureListener(port: BrowserPort) {
  if (listened.has(port)) return
  listened.add(port)
  port.on("message", (event) => {
    const message = event?.data as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown } | undefined
    if (!message || message.type !== "browser-response" || typeof message.id !== "string") return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.resolve(message.result)
    else entry.reject(new Error(typeof message.error === "string" ? message.error : "Browser request failed"))
  })
}

export function callBrowser(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
  port = defaultPort(),
): Effect.Effect<unknown, Error> {
  return Effect.tryPromise({
    try: () => request(method, params, timeoutMs, port),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

function request(method: string, params: Record<string, unknown>, timeoutMs: number, port: BrowserPort | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error("Browser is not attached — this only works in Desktop with the Navegador tab open"))
      return
    }
    ensureListener(port)
    seq += 1
    const id = `browser-${Date.now().toString(36)}-${seq}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Browser request ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      port.postMessage({ type: "browser-request", id, method, params })
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export function formatState(state: BrowserStateResult): string {
  if (!state.attached) return "Browser is not attached — open the Navegador tab first"
  const flags = [state.loading ? "loading" : "idle", state.canGoBack ? "can-back" : "", state.canGoForward ? "can-forward" : ""]
    .filter(Boolean)
    .join(", ")
  return `${state.title ?? "(no title)"}\n${state.url ?? "(no url)"}\n[${flags}]`
}

export function formatSnapshot(snapshot: BrowserSnapshotResult): string {
  const lines = snapshot.nodes.map((node) => `[${node.ref}] ${node.role} ${JSON.stringify(node.name)} ${node.selector}`)
  if (snapshot.truncated) lines.push(`… truncated to ${snapshot.nodes.length} nodes, refine with a more specific page state`)
  return [`${snapshot.title ?? "(no title)"}`, snapshot.url ?? "(no url)", "", ...lines].join("\n")
}
