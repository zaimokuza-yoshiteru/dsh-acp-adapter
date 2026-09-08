import { describe, expect, it } from 'vitest'
import { en, zh } from '../../../src/client/ui/locales.ts'

const parameters = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort()

describe('ACP locale dictionaries', () => {
  it('keeps complete, nonempty English and Chinese copy with identical interpolation parameters', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].trim(), key).not.toBe('')
      expect(en[key].trim(), key).not.toBe('')
      expect(parameters(en[key]), key).toEqual(parameters(zh[key]))
      expect(en[key], key).not.toMatch(/[\u3400-\u9fff]/u)
    }
  })
})
