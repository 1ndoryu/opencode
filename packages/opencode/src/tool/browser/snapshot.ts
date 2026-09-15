import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-snapshot.txt"
import { NOT_ATTACHED_MESSAGE, TabIdParam, callBrowser, formatSnapshot, tabParams } from "./bridge"
import type { BrowserSnapshotResult } from "./bridge"

export const Parameters = Schema.Struct({
  ...TabIdParam,
})

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["snapshot"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("snapshot", tabParams(ctx.sessionID, params.tabId))) as BrowserSnapshotResult
          if (!result.attached) {
            return { title: "Browser snapshot", output: NOT_ATTACHED_MESSAGE, metadata: {} }
          }
          return { title: "Browser snapshot", output: formatSnapshot(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
