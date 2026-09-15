import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-control.txt"
import { TabIdParam, callBrowser, formatState, tabParams } from "./bridge"
import type { BrowserStateResult } from "./bridge"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["back", "forward", "reload", "stop"]).annotate({
    description: "History action to run in the Desktop browser tab",
  }),
  ...TabIdParam,
})

export const BrowserControlTool = Tool.define(
  "browser_control",
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
          const result = (yield* callBrowser("control", { ...tabParams(ctx.sessionID, params.tabId), action: params.action })) as BrowserStateResult
          return { title: `Browser ${params.action}`, output: formatState(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
