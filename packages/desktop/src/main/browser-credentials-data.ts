// Pure Chrome-password helpers (no Electron imports so bun can test it).
// Chrome exports passwords as CSV with the English header
// "name,url,username,password" regardless of the UI locale.

export type CredentialEntry = {
  name: string
  url: string
  username: string
  password: string
}

export const CHROME_CSV_HEADER = "name,url,username,password"

// Minimal RFC-4180 reader: quoted fields, escaped quotes, commas and
// newlines inside quotes. Returns rows of raw field strings.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let i = 0
  const pushField = () => {
    row.push(field)
    field = ""
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }
  // A trailing newline must not produce a phantom empty row.
  const content = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  while (i < content.length) {
    const char = content[i] ?? ""
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          quoted = false
          i += 1
        }
      } else {
        field += char
        i += 1
      }
      continue
    }
    if (char === '"') {
      quoted = true
      i += 1
    } else if (char === ",") {
      pushField()
      i += 1
    } else if (char === "\n") {
      pushField()
      pushRow()
      i += 1
    } else {
      field += char
      i += 1
    }
  }
  if (row.length > 0 || field !== "") {
    pushField()
    pushRow()
  }
  return rows
}

function normalizeRow(row: string[]): CredentialEntry | undefined {
  const [name = "", url = "", username = "", password = ""] = row.map((cell) => cell.trim())
  if (!url || !username || !password) return undefined
  if (!URL.canParse(url)) return undefined
  return { name, url, username, password }
}

// Parses a Chrome password export. Throws on a wrong header so a random CSV
// is never mistaken for credentials.
export function parseChromeCsv(text: string): CredentialEntry[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error("Empty password file")
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase())
  const expected = CHROME_CSV_HEADER.split(",")
  const matches = expected.every((cell, index) => header[index] === cell)
  if (!matches) throw new Error(`Not a Chrome password export (header must be "${CHROME_CSV_HEADER}")`)
  const entries: CredentialEntry[] = []
  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === "")) continue
    const entry = normalizeRow(row)
    if (entry) entries.push(entry)
  }
  return entries
}

export function hostOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  return new URL(url).hostname.toLowerCase()
}

// Merges imported entries over the stored ones, keyed by origin+username.
// Re-importing the same CSV is idempotent and updates changed passwords.
export function mergeEntries(stored: CredentialEntry[], imported: CredentialEntry[]): CredentialEntry[] {
  const key = (entry: CredentialEntry) => `${hostOf(entry.url) ?? entry.url}|${entry.username.toLowerCase()}`
  const merged = new Map<string, CredentialEntry>()
  for (const entry of stored) merged.set(key(entry), entry)
  for (const entry of imported) merged.set(key(entry), entry)
  return [...merged.values()]
}

// Best stored entry for a page URL: exact host wins, else the longest parent
// domain suffix (login.contabo.com matches a contabo.com entry).
export function matchEntry(entries: CredentialEntry[], pageUrl: string): CredentialEntry | undefined {
  const host = hostOf(pageUrl)
  if (!host) return undefined
  let best: CredentialEntry | undefined
  for (const entry of entries) {
    const entryHost = hostOf(entry.url)
    if (!entryHost) continue
    if (host !== entryHost && !host.endsWith(`.${entryHost}`)) continue
    if (!best || (hostOf(best.url)?.length ?? 0) < entryHost.length) best = entry
  }
  return best
}
