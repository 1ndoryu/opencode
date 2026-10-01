import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import {
  parseDesktopShot,
  parseElements,
  parsePermissions,
  parseSnapshot,
  parseWindows,
} from "./pc-format"
import type { PcDesktopShot, PcPermissions, PcSnapshot, PcWindow } from "./pc-format"
import { write as writeLog } from "./logging"

// cua-driver CLI wrapper for the read-only PC surface (OP-36 F1). Talks to a
// daemon over a named pipe; the daemon is spawned on demand and stopped with
// the app. The app itself must run elevated (user decision 2026-10-01): a
// Medium daemon cannot PostMessage to High-integrity windows (UIPI silently
// drops it) and UIA reads come back empty, as seen with BDP/TpvNet.
//
// Single stable session label for every driver call. Driver snapshots and
// element tokens are scoped to the transport session: one CLI invocation
// without a label is its own implicit session and its tokens die with it
// (F0 lesson: stale_element_token across invocations). A constant label
// keeps snapshot->act chains working from F2 on.
export const PC_SESSION = "opencode-pc"

const PC_PIPE = "\\\\.\\pipe\\opencode-pc"
const CALL_TIMEOUT_MS = 30_000
const DAEMON_START_TIMEOUT_MS = 15_000
const MAX_BUFFER = 32 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 768

export interface ComputerDriver {
  permissions(): Promise<PcPermissions>
  windows(): Promise<PcWindow[]>
  desktop(): Promise<PcDesktopShot>
  snapshot(pid: number, windowId: number): Promise<PcSnapshot>
}

export class CuaDriver implements ComputerDriver {
  private daemon: ReturnType<typeof spawn> | undefined

  async permissions(): Promise<PcPermissions> {
    await this.ensureDaemon()
    return parsePermissions(await this.call("check_permissions", {}))
  }

  async windows(): Promise<PcWindow[]> {
    await this.ensureDaemon()
    return parseWindows(await this.call("list_windows", {}))
  }

  async desktop(): Promise<PcDesktopShot> {
    await this.ensureDaemon()
    return parseDesktopShot(
      await this.call("get_desktop_state", { max_image_dimension: MAX_IMAGE_DIMENSION }),
    )
  }

  async snapshot(pid: number, windowId: number): Promise<PcSnapshot> {
    await this.ensureDaemon()
    return parseSnapshot(
      await this.call("get_window_state", {
        pid,
        window_id: windowId,
        max_image_dimension: MAX_IMAGE_DIMENSION,
      }),
      pid,
      windowId,
    )
  }

  stop() {
    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill()
      writeLog("pc", "daemon stopped")
    }
    this.daemon = undefined
  }

  private call(tool: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out = runDriver(resolveDriverBin(), ["--socket", PC_PIPE, "call", tool], {
      ...params,
      session: PC_SESSION,
    })
    return out.then((stdout) => {
      const parsed: unknown = JSON.parse(stdout)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`PC driver call ${tool} returned non-object`)
      }
      const refusal = (parsed as { refusal?: unknown }).refusal
      if ((parsed as { status?: unknown }).status === "refused") {
        const code =
          typeof refusal === "object" && refusal !== null && typeof (refusal as { code?: unknown }).code === "string"
            ? (refusal as { code: string }).code
            : "refused"
        const message =
          typeof refusal === "object" &&
          refusal !== null &&
          typeof (refusal as { message?: unknown }).message === "string"
            ? (refusal as { message: string }).message
            : ""
        throw new Error(`PC driver refused ${tool} (${code})${message ? `: ${message}` : ""}`)
      }
      return parsed as Record<string, unknown>
    })
  }

  private async ensureDaemon() {
    if (this.daemon && !this.daemon.killed && (await daemonAlive())) return
    this.daemon = undefined
    const bin = resolveDriverBin()
    writeLog("pc", "spawning daemon", { bin })
    // Detached + stdio ignored: the daemon must outlive the spawn call and
    // must never inherit the app's console. Killed explicitly in stop().
    this.daemon = spawn(bin, ["--socket", PC_PIPE, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    this.daemon.unref()
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    for (;;) {
      if (await daemonAlive()) return
      if (Date.now() >= deadline) throw new Error(`PC driver daemon did not come up (pipe ${PC_PIPE})`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
}

const shared = new CuaDriver()

export function sharedDriver(): CuaDriver {
  return shared
}

export function stopSharedDriver() {
  shared.stop()
}

// Binary resolution (fail-closed, no download in F1): explicit env override
// first, then the app userData bin dir (future installer target), then PATH.
// Vendoring the 10MB+ exe inside the repo is out; the exact inspected
// installer stays referenced from the OP-36 plan until the F2 installer story.
export function resolveDriverBin(): string {
  if (process.env.CUA_DRIVER_BIN) return process.env.CUA_DRIVER_BIN
  if (process.platform === "win32") {
    const userBin = join(app.getPath("userData"), "bin", "cua-driver.exe")
    if (existsSync(userBin)) return userBin
    return "cua-driver.exe"
  }
  return "cua-driver"
}

function runDriver(bin: string, args: string[], params: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    // JSON goes over stdin, never argv: PowerShell 5.1 strips quotes around
    // field names in multi-field args (F0 lesson) and argv has length caps.
    const child = execFile(bin, args, { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (error, stdout) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      resolve(stdout)
    })
    child.stdin?.write(JSON.stringify(params))
    child.stdin?.end()
  })
}

async function daemonAlive(): Promise<boolean> {
  const out = await runDriver(resolveDriverBin(), ["--socket", PC_PIPE, "status"], {
    session: PC_SESSION,
  }).catch(() => "")
  return out.includes("daemon is running")
}
