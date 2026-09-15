import type { ElementAttachmentPart } from "@/context/prompt"

export { formatElementNote } from "@opencode-ai/session-ui/v2/prompt-input/element-note"

export type PromptElement = Pick<
  ElementAttachmentPart,
  "url" | "selector" | "tagName" | "xpath" | "role" | "label" | "text" | "attributes" | "outerHtml"
>

export function createElementMetadata(input: PromptElement) {
  return {
    opencodeElement: {
      url: input.url,
      selector: input.selector,
      tagName: input.tagName,
      xpath: input.xpath,
      role: input.role,
      label: input.label,
      text: input.text,
      attributes: input.attributes,
      outerHtml: input.outerHtml,
    },
  }
}

export function readElementMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeElement?: unknown }).opencodeElement
  if (!meta || typeof meta !== "object") return
  const url = (meta as { url?: unknown }).url
  const selector = (meta as { selector?: unknown }).selector
  const tagName = (meta as { tagName?: unknown }).tagName
  if (typeof url !== "string" || typeof selector !== "string" || typeof tagName !== "string") return
  const optional = (key: string) => {
    const field = (meta as Record<string, unknown>)[key]
    return typeof field === "string" ? field : undefined
  }
  const attributes = (meta as { attributes?: unknown }).attributes
  return {
    url,
    selector,
    tagName,
    xpath: optional("xpath"),
    role: optional("role"),
    label: optional("label"),
    text: optional("text"),
    attributes:
      attributes && typeof attributes === "object" && !Array.isArray(attributes)
        ? (attributes as Record<string, string>)
        : undefined,
    outerHtml: optional("outerHtml"),
  } satisfies PromptElement
}
