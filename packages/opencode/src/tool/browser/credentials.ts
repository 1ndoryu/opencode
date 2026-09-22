import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-credentials.txt"
import { TabIdParam, callBrowser, tabParams } from "./bridge"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["import", "status", "login", "forget"]).annotate({
    description:
      "import: store logins from the Chrome password CSV export; status: list stored domains/usernames; login: fill the current tab page login form; forget: delete stored logins",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "CSV file to import (import only). Defaults to the Chrome password export in Downloads.",
  }),
  domain: Schema.optional(Schema.String).annotate({
    description: "Limit forget to this domain, e.g. contabo.com (forget only)",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Limit forget to this username (forget only)",
  }),
  ...TabIdParam,
})

type ImportResult = { attached: boolean; file: string; imported: number; total: number; domains: string[] }
type StatusResult = { attached: boolean; available: boolean; count: number; entries: { domain: string; username: string }[] }
type LoginResult = { attached: boolean; tabId?: string; ok: boolean; domain?: string; username?: string; userFilled?: boolean; error?: string }
type ForgetResult = { attached: boolean; removed: number; count: number }

export const BrowserCredentialsTool = Tool.define(
  "browser_credentials",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.action],
            always: ["*"],
            metadata: { action: params.action },
          })
          const base = tabParams(ctx.sessionID, params.tabId)
          if (params.action === "import") {
            const result = (yield* callBrowser("credentials-import", params.path === undefined ? base : { ...base, path: params.path })) as ImportResult
            return {
              title: "Browser credentials import",
              output: `Imported ${result.imported} logins from ${result.file} (${result.total} stored, domains: ${result.domains.join(", ") || "(none)"})`,
              metadata: {},
            }
          }
          if (params.action === "status") {
            const result = (yield* callBrowser("credentials-status", base)) as StatusResult
            if (!result.available)
              return { title: "Browser credentials status", output: "Credential encryption unavailable (OS keychain unreachable)", metadata: {} }
            if (result.count === 0)
              return { title: "Browser credentials status", output: "No stored logins — import the Chrome CSV first", metadata: {} }
            return {
              title: "Browser credentials status",
              output: `${result.count} stored logins:\n${result.entries.map((entry) => `- ${entry.username} @ ${entry.domain}`).join("\n")}`,
              metadata: {},
            }
          }
          if (params.action === "login") {
            const result = (yield* callBrowser("credentials-login", base)) as LoginResult
            if (!result.ok) return { title: "Browser credentials login", output: `Login fill failed: ${result.error ?? "unknown error"}`, metadata: {} }
            return {
              title: "Browser credentials login",
              output: `Filled login for ${result.username} @ ${result.domain} (username field: ${result.userFilled === true ? "filled" : "not found, password only"}) — verify with browser_snapshot`,
              metadata: {},
            }
          }
          const forgetParams = { ...base }
          if (params.domain !== undefined) forgetParams.domain = params.domain
          if (params.username !== undefined) forgetParams.username = params.username
          const result = (yield* callBrowser("credentials-forget", forgetParams)) as ForgetResult
          return {
            title: "Browser credentials forget",
            output: `Removed ${result.removed} stored logins (${result.count} remain)`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
