import { app, safeStorage, type WebContents } from "electron"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hostOf, matchEntry, mergeEntries, parseChromeCsv, type CredentialEntry } from "./browser-credentials-data"
import { write as writeLog } from "./logging"

// User-imported website logins (Chrome CSV export) for the agent browser.
// Secrets live encrypted with the OS keychain (safeStorage/DPAPI) in
// userData and are NEVER returned to the model: status lists domains and
// usernames only, login fills inside the guest via main-side script.

// Chrome (any locale) names its password export exactly this way.
const CHROME_EXPORT_FILENAME = "Contraseñas de Chrome.csv"

function storePath(): string {
  return join(app.getPath("userData"), "browser-credentials.dat")
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("Credential encryption unavailable (OS keychain unreachable) — cannot store passwords")
}

async function loadEntries(): Promise<CredentialEntry[]> {
  requireEncryption()
  try {
    const encrypted = await readFile(storePath())
    const json = safeStorage.decryptString(encrypted)
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is CredentialEntry =>
        !!entry && typeof entry === "object" && typeof (entry as CredentialEntry).url === "string",
    )
  } catch {
    return []
  }
}

async function saveEntries(entries: CredentialEntry[]): Promise<void> {
  requireEncryption()
  await writeFile(storePath(), safeStorage.encryptString(JSON.stringify(entries)))
}

export type CredentialImportResult = {
  file: string
  imported: number
  total: number
  domains: string[]
}

export async function importCredentialsFromCsv(filePath?: string): Promise<CredentialImportResult> {
  requireEncryption()
  const file = filePath ?? join(app.getPath("downloads"), CHROME_EXPORT_FILENAME)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch {
    throw new Error(
      `Password file not found: ${file} — export it from Chrome (password manager → Export passwords) and retry`,
    )
  }
  const imported = parseChromeCsv(text)
  const merged = mergeEntries(await loadEntries(), imported)
  await saveEntries(merged)
  const domains = [...new Set(imported.map((entry) => hostOf(entry.url)).filter((host) => host !== undefined))]
  writeLog("browser", "credentials imported", { file, imported: imported.length, total: merged.length })
  return { file, imported: imported.length, total: merged.length, domains }
}

export type CredentialStatus = {
  available: boolean
  count: number
  entries: { domain: string; username: string }[]
}

export async function credentialStatus(): Promise<CredentialStatus> {
  if (!safeStorage.isEncryptionAvailable()) return { available: false, count: 0, entries: [] }
  const entries = await loadEntries()
  return {
    available: true,
    count: entries.length,
    entries: entries.map((entry) => ({ domain: hostOf(entry.url) ?? entry.url, username: entry.username })),
  }
}

export async function forgetCredentials(domain?: string, username?: string): Promise<{ removed: number; count: number }> {
  const stored = await loadEntries()
  const kept = stored.filter((entry) => {
    if (domain && hostOf(entry.url) !== domain.toLowerCase()) return true
    if (username && entry.username.toLowerCase() !== username.toLowerCase()) return true
    return false
  })
  await saveEntries(kept)
  const removed = stored.length - kept.length
  writeLog("browser", "credentials forgotten", { domain, removed })
  return { removed, count: kept.length }
}

// Fills the login form of the guest's page with the stored credential for
// its domain. The username/password are interpolated into the page script in
// main and never travel back to the model — only ok/username/domain do.
const LOGIN_FILL_SCRIPT = `((user, pass) => {
  const visible = (element) => {
    if (!element || element.disabled) return false
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null
    return !!rect && rect.width > 0 && rect.height > 0
  }
  const setNative = (element, value) => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value")
    if (descriptor && descriptor.set) descriptor.set.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible)
  if (!password) return { ok: false, error: "no password field on this page" }
  // Username: closest visible text/email field before the password in DOM
  // order (covers split user-then-password flows showing only one step),
  // else a named login field, else the first visible text input.
  const fields = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')).filter(visible)
  const before = fields.filter((field) => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)
  const named = fields.find((field) => /user|email|login|account/i.test(field.name || field.id || field.placeholder || ""))
  // before[] is already in document order, so the last one is the closest
  // field preceding the password.
  const userField = before.length > 0 ? before[before.length - 1] : (named ?? fields[0])
  let userFilled = false
  if (userField) {
    setNative(userField, user)
    userFilled = true
  }
  setNative(password, pass)
  return { ok: true, userFilled }
})`

export type LoginFillResult = {
  ok: boolean
  domain?: string
  username?: string
  userFilled?: boolean
  error?: string
}

export async function fillLoginForGuest(guest: WebContents): Promise<LoginFillResult> {
  const entries = await loadEntries()
  if (entries.length === 0) throw new Error("No stored credentials — import the Chrome CSV first")
  const url = guest.getURL()
  const entry = matchEntry(entries, url)
  if (!entry) throw new Error(`No stored credential for ${(hostOf(url) ?? url)} — import it or log in manually`)
  const result = (await guest
    .executeJavaScript(`(${LOGIN_FILL_SCRIPT})(${JSON.stringify(entry.username)}, ${JSON.stringify(entry.password)})`, true)
    .catch((error: unknown) => ({ ok: false, error: `js failed: ${String(error).slice(0, 300)}` }))) as LoginFillResult
  writeLog("browser", "login fill", { domain: hostOf(entry.url), ok: result.ok, userFilled: result.userFilled })
  if (!result.ok) return { ok: false, error: result.error ?? "login fill failed" }
  return { ok: true, domain: hostOf(entry.url), username: entry.username, userFilled: result.userFilled }
}
