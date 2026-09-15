import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-state.txt"
import { TabIdParam, callBrowser, formatState, tabParams } from "./bridge"
import type { BrowserStateResult } from "./bridge"

export const Parameters = Schema.Struct({
  ...TabIdParam,
})

export const BrowserStateTool = Tool.define(
  "browser_state",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["state"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("state", tabParams(ctx.sessionID, params.tabId))) as BrowserStateResult
          return { title: "Browser state", output: formatState(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
