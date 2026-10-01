import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./pc-act.txt"
import { callPc, formatSnapshot, markUnchanged } from "./bridge"
import type { PcActResult } from "./bridge"

export const Parameters = Schema.Struct({
  pid: Schema.Number.annotate({ description: "Process id from pc_windows output" }),
  window_id: Schema.Number.annotate({ description: "Window id from pc_windows output" }),
  action: Schema.Literals(["click", "type", "key", "scroll"]).annotate({
    description: "click: invoke element_token or x/y; type: insert text (needs text); key: press key (needs key); scroll: scroll region (needs direction)",
  }),
  element_token: Schema.optional(Schema.String).annotate({
    description:
      "Copy the token= value from the latest pc_snapshot of this window (e.g. s00000002:15). The [15] list index is NOT a token — passing it fails. Preferred over x/y; dies on the next snapshot of the same window.",
  }),
  x: Schema.optional(Schema.Number).annotate({ description: "Window pixel x for click without element_token (canvas targets)" }),
  y: Schema.optional(Schema.Number).annotate({ description: "Window pixel y for click without element_token (canvas targets)" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type. Never passwords in v1." }),
  key: Schema.optional(Schema.String).annotate({
    description: "Key for key action: return, tab, escape, arrows, space, delete, home, end, pageup, pagedown, f1-f12, letters, digits",
  }),
  modifiers: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Optional modifiers for key: ctrl, shift, alt, win" }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({ description: "Direction for scroll" }),
  delivery_mode: Schema.optional(Schema.Literals(["background", "foreground"])).annotate({
    description: "Defaults to background (never steals focus). Use foreground only after the driver answers background_unavailable.",
  }),
})

export const PcActTool = Tool.define(
  "pc_act",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "computer",
            patterns: ["act", params.action],
            always: ["*"],
            metadata: {},
          })
          const result = (yield* callPc("act", { ...params })) as PcActResult
          const output = [result.detail, "", formatSnapshot(markUnchanged(result.verify))].join("\n")
          return {
            title: "PC act",
            output,
            metadata: {},
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url: `data:image/png;base64,${result.verify.pngBase64}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)
