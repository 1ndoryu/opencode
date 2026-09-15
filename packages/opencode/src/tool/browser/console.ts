import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-console.txt"
import { callBrowser } from "./bridge"
import type { BrowserConsoleResult } from "./bridge"

export const Parameters = Schema.Struct({
  limit: Schema.optional(Schema.Number).annotate({ description: "Max entries to return, newest last (default 100, max 200)" }),
  clear: Schema.optional(Schema.Boolean).annotate({ description: "Clear the buffered entries after reading" }),
})

export const BrowserConsoleTool = Tool.define(
  "browser_console",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["console"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("console", {
            limit: params.limit ?? 100,
            clear: params.clear ?? false,
          })) as BrowserConsoleResult
          if (!result.attached) return { title: "Browser console", output: "Browser is not attached — open the Navegador tab first", metadata: {} }
          if (result.entries.length === 0) return { title: "Browser console", output: "Console buffer is empty", metadata: {} }
          const lines = result.entries.map(
            (entry) =>
              `${new Date(entry.ts).toISOString()} [${entry.level}] ${entry.sourceId}:${entry.line} ${entry.message}`,
          )
          return { title: "Browser console", output: lines.join("\n"), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
