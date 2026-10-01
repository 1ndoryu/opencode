import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./pc-snapshot.txt"
import { callPc, formatSnapshot, markUnchanged } from "./bridge"
import type { PcSnapshotResult } from "./bridge"

export const Parameters = Schema.Struct({
  pid: Schema.Number.annotate({ description: "Process id from pc_windows output" }),
  window_id: Schema.Number.annotate({ description: "Window id from pc_windows output" }),
})

export const PcSnapshotTool = Tool.define(
  "pc_snapshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "computer", patterns: ["snapshot"], always: ["*"], metadata: {} })
          const result = (yield* callPc("snapshot", { pid: params.pid, window_id: params.window_id })) as PcSnapshotResult
          const output = formatSnapshot(markUnchanged(result))
          return {
            title: "PC snapshot",
            output,
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
