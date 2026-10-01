import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./pc-screenshot.txt"
import { callPc } from "./bridge"
import type { PcShotResult } from "./bridge"

export const Parameters = Schema.Struct({})

export const PcScreenshotTool = Tool.define(
  "pc_screenshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "computer", patterns: ["screenshot"], always: ["*"], metadata: {} })
          const result = (yield* callPc("screenshot")) as PcShotResult
          return {
            title: "PC screenshot",
            output: `Desktop screenshot captured (${result.width}x${result.height})`,
            metadata: {},
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url: `data:image/png;base64,${result.pngBase64}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
