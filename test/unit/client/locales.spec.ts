import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../../../src/client/ui/locales.ts'

const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort()

describe('ACP locale dictionaries', () => {
  const metadata = (language: string): Record<string, string> =>
    (
      JSON.parse(readFileSync(new URL(`../../../locale/${language}.json`, import.meta.url), 'utf8')) as {
        meta: Record<string, string>
      }
    ).meta
  const dictionaries: { name: string; english: Record<string, string>; chinese: Record<string, string> }[] = [
    { name: 'panel', english: en, chinese: zh },
    { name: 'plugin metadata', english: metadata('en'), chinese: metadata('zh') },
  ]
  it.each(dictionaries)('keeps $name copy complete with matching interpolation parameters', ({ english, chinese }) => {
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort())
    for (const [key, text] of Object.entries(chinese)) {
      const translated = english[key] ?? ''
      expect(text.trim(), key).not.toBe('')
      expect(translated.trim(), key).not.toBe('')
      expect(parameters(translated), key).toEqual(parameters(text))
      expect(translated, key).not.toMatch(/[\u3400-\u9fff]/u)
    }
  })
})
