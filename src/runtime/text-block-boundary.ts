/** Delimit generated text blocks for consumers that concatenate adjacent block content. */
export const generatedContextSeparator = '\n\n'

export function generatedContextBlock(text: string): string {
  return `${generatedContextSeparator}${text}${generatedContextSeparator}`
}

/** Only these generated leading blocks may be omitted after confirmed delivery.
 * The remainder contains admitted messages and must always cross the wire. */
export interface AcpPromptProjection {
  readonly key: string
  readonly prefixLength: number
}
