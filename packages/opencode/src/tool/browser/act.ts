import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./browser-act.txt"
import { NOT_ATTACHED_MESSAGE, callBrowser, formatSnapshot } from "./bridge"
import type { BrowserSnapshotResult } from "./bridge"

export const Parameters = Schema.Struct({
  ref: Schema.Number.annotate({ description: "Numeric element ref from the latest browser_snapshot" }),
  action: Schema.Literals(["click", "fill", "focus", "hover", "scroll"]).annotate({
    description: "Action to run on the element",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for fill (input value or select option)" }),
})

type ActResult = {
  attached: boolean
  ok: boolean
  error?: string
  snapshot: BrowserSnapshotResult
}

export const BrowserActTool = Tool.define(
  "browser_act",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser",
            patterns: [`${params.action} ref${params.ref}`],
            always: ["*"],
            metadata: { ref: params.ref, action: params.action },
          })
          const result = (yield* callBrowser("act", {
            ref: params.ref,
            action: params.action,
            text: params.text ?? "",
          })) as ActResult
          if (!result.attached) {
            return { title: "Browser act", output: NOT_ATTACHED_MESSAGE, metadata: {} }
          }
          if (!result.ok) return { title: "Browser act", output: `Action failed: ${result.error ?? "unknown"}`, metadata: {} }
          return { title: "Browser act", output: `ok\n\n${formatSnapshot(result.snapshot)}`, metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
