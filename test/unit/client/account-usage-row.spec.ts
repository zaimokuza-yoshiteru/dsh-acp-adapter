import { expect, it } from 'vitest'
import { accountUsageSummary } from '../../../src/client/ui/AccountUsageRow.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'
import type { AcpAccountUsageView } from '../../../src/contract/account-usage.ts'
import type { AcpTranslate } from '../../../src/client/ui/AcpSection.ts'

it.each([
  ['en', en],
  ['zh', zh],
] as const)('preserves absent and zero account values in %s', (language, copy) => {
  const t: AcpTranslate = (key, params) => copy[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name]))
  const empty: AcpAccountUsageView = {
    status: 'ready',
    provider: 'codex',
    checkedAt: 10,
    plan: null,
    credits: null,
    windows: [],
  }
  expect(accountUsageSummary(empty, t, language)).toEqual({ plan: null, credits: null, windows: [] })
  expect(accountUsageSummary({ ...empty, credits: { kind: 'unlimited' } }, t, language).credits).toBe(
    t('accountCreditsUnlimited'),
  )
  expect(accountUsageSummary({ ...empty, credits: { kind: 'available' } }, t, language).credits).toBe(
    t('accountCreditsAvailable'),
  )
  expect(accountUsageSummary({ ...empty, plan: 'Business' }, t, language).plan).toBe('Business')
  const balance = (credits: string) => accountUsageSummary({ ...empty, credits }, t, language).credits
  expect(balance('24226.0462905000')).toBe('24,226.05')
  expect(balance('99999999999999999999.0999')).toBe('99,999,999,999,999,999,999.1')
  expect(balance('0.0000001')).toBe('<0.01')
  const result = accountUsageSummary(
    {
      ...empty,
      credits: '0',
      windows: [
        { key: 'primary', minutes: 300, remainingPercent: 0, resetsAt: null },
        { key: 'secondary', minutes: 10080, remainingPercent: 50.5, resetsAt: 1_800_000_000_000 },
        { key: 'gemini-weekly', minutes: null, remainingPercent: 99, resetsAt: null },
        { key: 'primary:1', bucketName: 'Code Review', minutes: 300, remainingPercent: 80, resetsAt: null },
        { key: 'secondary:1', bucketName: 'Code Review', minutes: 10080, remainingPercent: 15, resetsAt: null },
        { key: 'primary:2', bucketName: null, minutes: 15, remainingPercent: 22, resetsAt: null },
      ],
    },
    t,
    language,
  )
  expect(result.credits).toBe('0')
  expect(result.windows).toHaveLength(6)
  expect(result.windows[0]).toMatchObject({
    label: t('accountHours', { hours: 5 }),
    value: 0,
    remaining: t('accountRemaining', { percent: '0%' }),
    reset: null,
  })
  expect(result.windows[1]).toMatchObject({
    label: t('accountWeekly'),
    value: 50.5,
    remaining: t('accountRemaining', { percent: '50.5%' }),
  })
  expect(result.windows[1]?.reset).toContain(language === 'zh' ? '重置' : 'Resets')
  expect(result.windows[2]?.label).toBe('gemini-weekly')
  expect(result.windows[3]?.label).toBe('Code Review · ' + t('accountHours', { hours: 5 }))
  expect(result.windows[4]?.label).toBe('Code Review · ' + t('accountWeekly'))
  expect(result.windows[5]?.label).toBe(
    t('accountAdditionalBucket', { number: 2 }) + ' · ' + t('accountMinutes', { minutes: 15 }),
  )
})
