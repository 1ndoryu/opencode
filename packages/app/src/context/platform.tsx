import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type { DraftStore } from "@/utils/draft-store"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

export type BrowserPanelState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserCapture = {
  buffer: ArrayBuffer
  width: number
  height: number
}

export type BrowserElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserPickedElement = {
  selector: string
  xpath: string
  role: string
  ancestors: string[]
  attributes: Record<string, string>
  outerHtml: string
  tagName: string
  id: string
  classes: string[]
  text: string
  href: string
  rect: BrowserElementRect
  url: string
  title: string
}

export type BrowserPickResult = {
  element: BrowserPickedElement
  capture: BrowserCapture | null
}

export type BrowserTabState = {
  tabId: string
  state: BrowserPanelState | null
}

// Mirrors the desktop preload payload (OP-23): an agent acting on a
// background tab reports which session acted.
export type BrowserTabSelect = {
  tabId: string
  sessionID?: string
}

export type BrowserPlatform = {
  attach(guestId: number, tabId: string): Promise<BrowserPanelState>
  detach(tabId?: string): Promise<void>
  selectTab(tabId: string): Promise<void>
  pinSession(sessionID: string, tabId: string): Promise<void>
  closeTab(tabId: string): Promise<void>
  navigate(url: string, tabId?: string): Promise<BrowserPanelState>
  back(): Promise<BrowserPanelState>
  forward(): Promise<BrowserPanelState>
  reload(): Promise<BrowserPanelState>
  stop(): Promise<BrowserPanelState>
  getState(): Promise<BrowserPanelState | null>
  capture(): Promise<BrowserCapture | null>
  setZoom(factor: number): Promise<BrowserPanelState>
  pick(): Promise<BrowserPickResult | null>
  cancelPick(): Promise<void>
  onState(cb: (update: BrowserTabState) => void): () => void
  onSelectTab(cb: (select: BrowserTabSelect) => void): () => void
}

export type MarketplaceAviso = {
  titulo: string
  precio: number
  operacion: string
}

export type MarketplaceBorrador = {
  intencion: string
  texto: string
}

export type MarketplaceCatalog = {
  avisos: MarketplaceAviso[]
  fetchedAt: number
  fromCache: boolean
  error?: string
}

// OP-33 F2: manual Marketplace drafts. Read-only by design: the strip shows
// reply drafts for the user to copy; nothing is ever sent automatically.
export type MarketplacePlatform = {
  catalog(opts: { apiUrl: string; refresh?: boolean }): Promise<MarketplaceCatalog>
  drafts(input: { mensaje: string; tituloFb?: string; catalogo?: MarketplaceAviso[] }): Promise<MarketplaceBorrador[]>
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Open a web or mail URL in the default system application */
  openExternal(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Open a local file URL in its default app (desktop only) */
  openLocalFile?(url: string): void

  /** Reveal a local path in the system file manager; false when the path does not exist (desktop only) */
  revealPath?(path: string): Promise<boolean>

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Prompt drafts, history, and their blobs. */
  draftStore?: DraftStore

  /** Stable platform window identity for window-scoped persistence */
  windowID?: string

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Side browser guest (Electron desktop only) */
  browser?: BrowserPlatform

  /** Manual Marketplace reply drafts (Electron desktop only, OP-33) */
  marketplace?: MarketplacePlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Whether the native desktop window is fullscreen */
  windowFullscreen?: Accessor<boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Force focus styles on interactive elements through desktop devtools (desktop only) */
  setForceFocus?(enabled: boolean): Promise<void>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
