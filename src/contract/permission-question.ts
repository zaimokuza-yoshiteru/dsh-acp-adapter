/** Native question strings and option labels remain valid on clients without the ACP composer. */
export interface AcpQuestionText {
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

export type AcpQuestionLanguage = 'en' | 'zh'

/** A translated line can reuse the operation verbatim from the native field. Offsets are UTF-16 indices. */
type TextEdit = readonly [from: number, to: number, replacement: string]
type Translation = string | readonly TextEdit[]

interface AcpQuestionTranslation {
  readonly language: AcpQuestionLanguage
  readonly question?: Translation
  readonly header?: string
  readonly detail?: Translation
  /** Stable native labels are the answer values. Only translated display labels are carried here. */
  readonly labels?: readonly string[]
}

export interface AcpQuestionItem extends AcpQuestionText {
  readonly id: string
  readonly multiSelect?: boolean
  readonly acpTranslation?: AcpQuestionTranslation
}

// Native RC.5 requires a complete fallback string. Carry changed portions of large localized
// fields so a translated scope label cannot double the size of a file, command or delegated task.
function translateField(source: string | undefined, target: string): Translation {
  if (!source || target.length < 256) return target
  const before = source.split('\n')
  const after = target.split('\n')
  if (before.length !== after.length) return target
  const edits: TextEdit[] = []
  let offset = 0
  for (const [index, line] of before.entries()) {
    const next = after[index]!
    if (line !== next) {
      let left = 0
      let right = 0
      const limit = Math.min(line.length, next.length)
      while (left < limit && line[left] === next[left]) left++
      while (right < limit - left && line[line.length - 1 - right] === next[next.length - 1 - right]) right++
      edits.push([offset + left, offset + line.length - right, next.slice(left, next.length - right)])
    }
    offset += line.length + 1
  }
  return edits
}

function translatedField(source: string, translation: Translation): string {
  if (typeof translation === 'string') return translation
  const parts: string[] = []
  let offset = 0
  for (const [from, to, text] of translation) {
    parts.push(source.slice(offset, from), text)
    offset = to
  }
  parts.push(source.slice(offset))
  return parts.join('')
}

/** Omit unchanged Agent prose, request details and option labels from the additional wire data. */
export function permissionQuestionTranslation(
  language: AcpQuestionLanguage,
  original: AcpQuestionText,
  translated: AcpQuestionText,
): AcpQuestionTranslation {
  const labels = translated.options?.map((option) => option.label)
  return {
    language,
    ...(translated.header !== original.header && translated.header !== undefined ? { header: translated.header } : {}),
    ...(translated.question !== original.question
      ? { question: translateField(original.question, translated.question) }
      : {}),
    ...(translated.detail !== original.detail && translated.detail !== undefined
      ? { detail: translateField(original.detail, translated.detail) }
      : {}),
    ...(labels?.some((label, index) => label !== original.options?.[index]?.label) ? { labels } : {}),
  }
}

export function questionTextIn(item: AcpQuestionItem, language: AcpQuestionLanguage): AcpQuestionText {
  const translated = item.acpTranslation
  if (translated?.language !== language) return item
  return {
    ...item,
    ...(translated.header === undefined ? {} : { header: translated.header }),
    question: translated.question === undefined ? item.question : translatedField(item.question, translated.question),
    ...(translated.detail === undefined ? {} : { detail: translatedField(item.detail ?? '', translated.detail) }),
    ...(translated.labels && translated.labels.length === item.options?.length
      ? { options: translated.labels.map((label) => ({ label })) }
      : {}),
  }
}
