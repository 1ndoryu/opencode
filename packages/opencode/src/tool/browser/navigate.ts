import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-navigate.txt"
import { TabIdParam, callBrowser, formatSnapshot, formatState, tabParams } from "./bridge"
import type { BrowserSnapshotResult, BrowserStateResult } from "./bridge"

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The http(s) URL to open in the Desktop browser tab" }),
  ...TabIdParam,
})

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: [params.url], always: ["*"], metadata: { url: params.url } })
          const navigated = (yield* callBrowser("navigate", { ...tabParams(ctx.sessionID, params.tabId), url: params.url })) as BrowserStateResult
          const snapshot = (yield* callBrowser("snapshot", tabParams(ctx.sessionID, params.tabId))) as BrowserSnapshotResult
          return {
            title: `Opened ${navigated.url ?? params.url}`,
            output: `${formatState(navigated)}\n\n${formatSnapshot(snapshot)}`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    }
  }),
)
