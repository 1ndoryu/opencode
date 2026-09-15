import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, type Accessor } from "solid-js"
import { reuseTimelineRows } from "./row-reconciliation"
import { Timeline, TimelineRow } from "./rows"

export { reuseTimelineRows } from "./row-reconciliation"

export function createTimelineProjection(input: {
  messages: Accessor<Message[]>
  userMessages: Accessor<UserMessage[]>
  sessionMessages: Accessor<SessionMessageInfo[]>
  parts: (messageID: string) => Part[]
  status: Accessor<SessionStatus>
  showReasoningSummaries: Accessor<boolean>
  inlineComments: Accessor<boolean>
}) {
  const messageByID = createMemo(() => new Map(input.messages().map((message) => [message.id, message] as const)))
  const assistantMessagesByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    input.messages().forEach((message) => {
      if (message.role !== "assistant") return
      const messages = result.get(message.parentID)
      if (messages) {
        messages.push(message)
        return
      }
      result.set(message.parentID, [message])
    })
    return result
  })
  // Turn skeleton: message identities only, never part text. Re-runs when messages
  // arrive or leave, not on streamed tokens.
  const turns = createMemo(() => {
    const getMessage = (messageID: string) =>
      messageByID().get(messageID) as UserMessage | AssistantMessage | undefined
    return Timeline.constructTurns(input.sessionMessages(), getMessage, input.userMessages())
  })
  // One shard memo per turn: a streamed token rebuilds only the rows of its own
  // turn. Every other turn keeps stable row identities by reference, so keyed
  // rows and the DOM stay put no matter how long the conversation grows.
  const turnShards = createMemo(() => {
    const skeleton = turns()
    return {
      activeMessageID: skeleton.activeMessageID,
      shards: skeleton.turns.map((turn, index) => {
        const isActive = turn.user.id === skeleton.activeMessageID
        return createMemo((previous: TimelineRow.TimelineRow[] | undefined) =>
          reuseTimelineRows(
            previous,
            Timeline.constructMessageRows(
              turn.user,
              input.parts,
              turn.assistants,
              index,
              input.showReasoningSummaries(),
              input.status().type,
              isActive,
              input.inlineComments(),
            ),
          ),
        )
      }),
    }
  })
  const resolved = createMemo(
    (previous: { rows: TimelineRow.TimelineRow[]; shards: TimelineRow.TimelineRow[][] } | undefined) => {
      const shards = turnShards().shards.map((shard) => shard())
      if (
        previous &&
        shards.length === previous.shards.length &&
        shards.every((shard, index) => shard === previous.shards[index])
      )
        return previous
      return { rows: shards.flat(), shards }
    },
  )
  const activeMessageID = createMemo(() => turnShards().activeMessageID)
  const rows = () => resolved().rows
  const rowByKey = createMemo(() => new Map(rows().map((row) => [TimelineRow.key(row), row] as const)))
  const messageRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if (!("userMessageID" in row) || result.has(row.userMessageID)) return
      result.set(row.userMessageID, index)
    })
    return result
  })
  const messageLastRowIndex = createMemo(() => {
    const result = new Map<string, number>()
    rows().forEach((row, index) => {
      if ("userMessageID" in row) result.set(row.userMessageID, index)
    })
    return result
  })
  const lastAssistantGroupKey = createMemo(() => {
    const result = new Map<string, string>()
    rows().forEach((row) => {
      if (row._tag === "AssistantPart") result.set(row.userMessageID, row.group.key)
    })
    return result
  })

  return {
    activeMessageID,
    assistantMessagesByParent,
    lastAssistantGroupKey,
    messageByID,
    messageRowIndex,
    messageLastRowIndex,
    rowByKey,
    rows,
  }
}
