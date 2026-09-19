import type { Part } from "@opencode-ai/sdk/v2"
import { formatElementNote, readElementMetadata } from "@/utils/element-note"

export namespace MessageElement {
  export type MessageElement = {
    tagName: string
    selector: string
    note: string
  }

  // Browser element picks travel as synthetic text parts (same channel as
  // comment notes): the visible chat must show the badge, not the raw note.
  export const fromPart = (part: Part): MessageElement | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readElementMetadata(part.metadata)
    if (!next) return
    return {
      tagName: next.tagName,
      selector: next.selector,
      note: formatElementNote(next),
    }
  }
}
