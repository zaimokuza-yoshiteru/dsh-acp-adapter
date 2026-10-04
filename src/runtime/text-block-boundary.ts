/** Delimit generated text blocks for consumers that concatenate adjacent block content. */
export const generatedContextSeparator = '\n\n'

export function generatedContextBlock(text: string): string {
  return `${generatedContextSeparator}${text}${generatedContextSeparator}`
}
