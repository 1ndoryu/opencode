import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./pc-open.txt"
import { callPc, formatWindows } from "./bridge"
import type { PcOpenResult } from "./bridge"

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({ description: "App to launch: calculadora | notepad | explorer" }),
})

export const PcOpenTool = Tool.define(
  "pc_open",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "computer", patterns: ["open", params.target], always: ["*"], metadata: {} })
          const result = (yield* callPc("open", { target: params.target })) as PcOpenResult
          const output = [`Launched ${result.name} (pid ${result.pid})`, "", formatWindows(result.windows)].join("\n")
          return { title: "PC open", output, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
