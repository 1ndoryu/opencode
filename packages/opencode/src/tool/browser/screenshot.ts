import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-screenshot.txt"
import { callBrowser } from "./bridge"

export const Parameters = Schema.Struct({})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "browser", patterns: ["screenshot"], always: ["*"], metadata: {} })
          const result = (yield* callBrowser("screenshot")) as {
            attached: boolean
            width: number
            height: number
            dataUrl: string
          }
          if (!result.attached) {
            return { title: "Browser screenshot", output: "Browser is not attached — open the Navegador tab first", metadata: {} }
          }
          return {
            title: "Browser screenshot",
            output: `Screenshot captured (${result.width}x${result.height})`,
            metadata: {},
            attachments: [{ type: "file" as const, mime: "image/png", url: result.dataUrl }],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
