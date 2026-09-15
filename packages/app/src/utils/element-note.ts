import type { ElementAttachmentPart } from "@/context/prompt"

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

/**
 * Agent-bound detail block for a picked element. Mirrors formatCommentNote:
 * English source text for the model, expanded at submit time while the
 * editor only shows the short badge label.
 */
export function formatElementNote(input: PromptElement) {
  const lines = [`Picked <${input.tagName}> element from ${input.url}:`]
  lines.push(`selector: ${input.selector}`)
  if (input.xpath) lines.push(`xpath: ${input.xpath}`)
  if (input.role) lines.push(`role: ${input.role}`)
  if (input.label) lines.push(`label: ${input.label}`)
  if (input.text) lines.push(`text: ${input.text}`)
  if (input.attributes) {
    const attrs = Object.entries(input.attributes)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ")
    if (attrs) lines.push(`attributes: ${attrs}`)
  }
  if (input.outerHtml) lines.push(`html: ${input.outerHtml}`)
  return lines.join("\n")
}
