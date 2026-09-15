import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-snapshot.txt"
import { callBrowser, formatSnapshot } from "./bridge"
import type { BrowserSnapshotResult } from "./bridge"

export const Parameters = Schema.Struct({})

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["snapshot"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("snapshot")) as BrowserSnapshotResult
          if (!result.attached) {
            return { title: "Browser snapshot", output: "Browser is not attached — open the Navegador tab first", metadata: {} }
          }
          return { title: "Browser snapshot", output: formatSnapshot(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
