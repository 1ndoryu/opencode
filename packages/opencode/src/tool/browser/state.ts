import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-state.txt"
import { callBrowser, formatState } from "./bridge"
import type { BrowserStateResult } from "./bridge"

export const Parameters = Schema.Struct({})

export const BrowserStateTool = Tool.define(
  "browser_state",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["state"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("state")) as BrowserStateResult
          return { title: "Browser state", output: formatState(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
