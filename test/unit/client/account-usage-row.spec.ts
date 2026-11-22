import { expect, it } from 'vitest'
import { accountUsageLines } from '../../../src/client/ui/AccountUsageRow.ts'
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
  expect(accountUsageLines(empty, t, language)).toEqual([])
  expect(accountUsageLines({ ...empty, credits: { kind: 'unlimited' } }, t, language)).toEqual([
    t('accountCreditsUnlimited'),
  ])
  expect(accountUsageLines({ ...empty, credits: { kind: 'available' } }, t, language)).toEqual([
    t('accountCreditsAvailable'),
  ])
  expect(accountUsageLines({ ...empty, plan: 'Business' }, t, language)).toEqual([
    t('accountPlan', { plan: 'Business' }),
  ])
  const lines = accountUsageLines(
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
  expect(lines[0]).toBe(t('accountCredits', { credits: '0' }))
  expect(lines[1]).toBe(t('accountRemaining', { window: t('accountHours', { hours: 5 }), percent: '0' }))
  expect(lines[2]).toContain(t('accountWeekly'))
  expect(lines[2]).toContain(language === 'zh' ? '重置' : 'resets')
  expect(lines[3]).toContain('gemini-weekly')
  expect(lines[4]).toContain('Code Review · ' + t('accountHours', { hours: 5 }))
  expect(lines[5]).toContain('Code Review · ' + t('accountWeekly'))
  expect(lines[6]).toContain(t('accountAdditionalBucket', { number: 2 }) + ' · ' + t('accountMinutes', { minutes: 15 }))
})
