import { spawn } from "node:child_process"
import { appendFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import {
  buildActPayload,
  buildAuditLine,
  isOwnWindow,
  isPcKillActive,
  parseDesktopShot,
  parsePermissions,
  parseSnapshot,
  parseWindows,
  runDriver,
  PC_KILL_ENV,
} from "./pc-format"
import type {
  OpenTarget,
  PcDesktopShot,
  PcPermissions,
  PcSnapshot,
  PcWindow,
} from "./pc-format"
import { write as writeLog } from "./logging"
import { nativeT } from "./native-translations"

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
const DAEMON_START_TIMEOUT_MS = 15_000
const MAX_IMAGE_DIMENSION = 768

export type PcActAction = "click" | "type" | "key" | "scroll"

export type PcActResult = {
  ok: boolean
  detail: string
  verify: PcSnapshot
}

export type PcOpenResult = {
  pid: number
  name: string
  windows: PcWindow[]
}

export interface ComputerDriver {
  permissions(): Promise<PcPermissions>
  windows(): Promise<PcWindow[]>
  desktop(): Promise<PcDesktopShot>
  snapshot(pid: number, windowId: number): Promise<PcSnapshot>
  act(params: Record<string, unknown>): Promise<PcActResult>
  open(target: OpenTarget): Promise<PcOpenResult>
}

export class CuaDriver implements ComputerDriver {
  private daemon: ReturnType<typeof spawn> | undefined
  private flight: Promise<unknown> = Promise.resolve()

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

  // Single-flight act (OP-36 F2, avoids repeating OP-17/OP-23): exactly one
  // input action runs at a time; concurrent callers queue behind the chain.
  // Window scope is mandatory in v1 (BDP lesson: desktop-scope clicks are
  // screen-absolute and demand foreground, which steals the user's focus).
  async act(params: Record<string, unknown>): Promise<PcActResult> {
    const pid = params.pid
    const windowId = params.window_id
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(nativeT("desktop.pc.error.actNeedsPid"))
    }
    if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) {
      throw new Error(nativeT("desktop.pc.error.actNeedsWindow"))
    }
    // Kill-switch first: no daemon spawn, no driver call. Refusals are
    // audited so flipping the switch leaves a trace.
    if (isPcKillActive(process.env[PC_KILL_ENV], existsSync(join(app.getPath("userData"), "pc.kill")))) {
      void audit({ method: "act:refused-kill", pid, action: String(params.action ?? "act") })
      throw new Error(nativeT("desktop.pc.error.killActive"))
    }
    await this.ensureDaemon()
    await this.rejectOwnWindow(pid)
    const run = this.flight.then(() => this.runAct(params, pid, windowId))
    this.flight = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async open(target: OpenTarget): Promise<PcOpenResult> {
    if (isPcKillActive(process.env[PC_KILL_ENV], existsSync(join(app.getPath("userData"), "pc.kill")))) {
      void audit({ method: "open:refused-kill", action: target.kind === "aumid" ? target.aumid : target.name })
      throw new Error(nativeT("desktop.pc.error.killActive"))
    }
    await this.ensureDaemon()
    const run = this.flight.then(() => this.runOpen(target))
    this.flight = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  stop() {
    if (this.daemon && !this.daemon.killed) {
      this.daemon.kill()
      writeLog("pc", "daemon stopped")
    }
    this.daemon = undefined
  }

  private async runAct(params: Record<string, unknown>, pid: number, windowId: number): Promise<PcActResult> {
    const action = params.action
    const tool = action === "click" ? "click" : action === "type" ? "type_text" : action === "key" ? "press_key" : "scroll"
    const payload = buildActPayload(tool, params)
    const raw = await this.call(tool, payload)
    const detail = typeof raw.summary === "string" && raw.summary.length > 0 ? raw.summary : nativeT("desktop.pc.info.actOk", { tool })
    // Verify-by-capture: a fresh window snapshot proves (or disproves) the
    // effect without trusting the driver's own status alone.
    const verify = await this.snapshot(pid, windowId)
    void audit({
      method: `act:${tool}`,
      pid,
      windowId,
      action: String(action),
      chars: tool === "type_text" && typeof params.text === "string" ? params.text.length : undefined,
    })
    return { ok: true, detail, verify }
  }

  private async runOpen(target: OpenTarget): Promise<PcOpenResult> {
    const raw = await this.call("launch_app", target.kind === "aumid" ? { aumid: target.aumid } : { name: target.name })
    const launchedPid = typeof raw.pid === "number" ? raw.pid : 0
    const launchedName = typeof raw.name === "string" ? raw.name : target.kind === "aumid" ? target.aumid : target.name
    void audit({ method: "open", pid: launchedPid, action: launchedName })
    return { pid: launchedPid, name: launchedName, windows: parseWindows(raw) }
  }

  private async rejectOwnWindow(pid: number) {
    const windows = await this.windows()
    const entry = windows.find((window) => window.pid === pid)
    if (!entry) return
    const names = [app.getName(), "opencode", "propio", "electron"]
    if (isOwnWindow({ pid: entry.pid, processName: entry.processName, title: entry.title }, { pid: process.pid, names })) {
      void audit({ method: "act:refused-own-window", pid, action: entry.title })
      throw new Error(nativeT("desktop.pc.error.ownWindow"))
    }
  }

  private call(tool: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out = runDriver(resolveDriverBin(), ["--socket", PC_PIPE, "call", tool], {
      ...params,
      session: PC_SESSION,
    })
    return out.then((stdout) => {
      const parsed: unknown = JSON.parse(stdout)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(nativeT("desktop.pc.error.driverNonObject", { tool }))
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
        throw new Error(nativeT("desktop.pc.error.driverRefused", { tool, code, suffix: message ? `: ${message}` : "" }))
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
    // A missing/unlaunchable binary reports via an async 'error' event, not
    // a sync throw: without this listener it is an uncaught exception and
    // kills main (other-agent finding 2026-10-01, reproduced with node).
    // Clearing the handle keeps stop() safe; the readiness loop below then
    // fails fast with the regular daemonTimeout instead of hanging 15 s.
    let spawnFailed = false
    this.daemon.on("error", (error) => {
      spawnFailed = true
      this.daemon = undefined
      writeLog(
        "pc",
        "daemon spawn failed",
        { bin, message: error instanceof Error ? error.message : String(error) },
        "warn",
      )
    })
    this.daemon.unref()
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    for (;;) {
      if (spawnFailed) throw new Error(nativeT("desktop.pc.error.daemonTimeout", { pipe: PC_PIPE }))
      if (await daemonAlive()) return
      if (Date.now() >= deadline) throw new Error(nativeT("desktop.pc.error.daemonTimeout", { pipe: PC_PIPE }))
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

async function daemonAlive(): Promise<boolean> {
  const out = await runDriver(resolveDriverBin(), ["--socket", PC_PIPE, "status"], {
    session: PC_SESSION,
  }).catch(() => "")
  return out.includes("daemon is running")
}

// Audit trail (OP-36 F2): one JSON line per act/open/refusal in
// <userData>/pc.log — what, where, when, which session. Typed TEXT IS NEVER
// LOGGED here (passwords would land on disk); only the character count.
function audit(entry: { method: string; pid?: number; windowId?: number; window_id?: number; action: string; chars?: number }) {
  const line = buildAuditLine({
    method: entry.method,
    pid: entry.pid,
    windowId: entry.windowId ?? entry.window_id,
    action: entry.action,
    chars: entry.chars,
    session: PC_SESSION,
  })
  appendFile(join(app.getPath("userData"), "pc.log"), line).catch(() => undefined)
}
