/**
 * Agent-bound detail block for a picked browser element. Single source of
 * truth for both the submit-time expansion (build-request-parts) and the
 * editor badge tooltip: the tooltip shows verbatim what the model receives.
 * Input is structural so app and session-ui element part types both fit.
 */
export type ElementNoteInput = {
  url: string
  selector: string
  tagName: string
  xpath?: string
  role?: string
  label?: string
  text?: string
  attributes?: Record<string, string>
  outerHtml?: string
}

export function formatElementNote(input: ElementNoteInput) {
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
