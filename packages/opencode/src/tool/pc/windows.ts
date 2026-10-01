import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./pc-windows.txt"
import { callPc, formatWindows } from "./bridge"
import type { PcWindowResult } from "./bridge"

export const Parameters = Schema.Struct({})

export const PcWindowsTool = Tool.define(
  "pc_windows",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "computer", patterns: ["windows"], always: ["*"], metadata: {} })
          const result = (yield* callPc("windows")) as PcWindowResult[]
          return { title: "PC windows", output: formatWindows(result), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
