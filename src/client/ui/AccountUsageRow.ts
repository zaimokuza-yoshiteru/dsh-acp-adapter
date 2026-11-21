import { createElement as h, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { accountUsageLinks, AcpAccountUsageView } from '../../contract/account-usage.ts'
import type { AcpTranslate } from './AcpSection.ts'
import css from './AcpSection.module.css'

type UsageWindow = AcpAccountUsageView['windows'][number]

function localTime(epoch: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(epoch)
}

function periodLabel(window: UsageWindow, primary: boolean, t: AcpTranslate): string {
  if (window.minutes === 10080) return t('accountWeekly')
  if (window.minutes === 1440) return t('accountDaily')
  if (window.minutes && window.minutes % 60 === 0) return t('accountHours', { hours: window.minutes / 60 })
  if (window.minutes) return t('accountMinutes', { minutes: window.minutes })
  return t(primary ? 'accountQuota' : 'accountOtherQuota')
}

function quotaLabel(window: UsageWindow, t: AcpTranslate): string {
  if (window.bucketName === undefined && window.key !== 'primary' && window.key !== 'secondary') return window.key
  const [period, index = '1'] = window.key.split(':')
  const duration = periodLabel(window, period === 'primary', t)
  if (window.bucketName === undefined) return duration
  const bucket = window.bucketName ?? t('accountAdditionalBucket', { number: index })
  return t('accountBucketWindow', { bucket, duration })
}

/** The CLI owns these buckets and units. An absent window or credit balance stays absent. */
export function accountUsageLines(view: AcpAccountUsageView, t: AcpTranslate, locale: string): string[] {
  const lines: string[] = []
  if (view.plan) lines.push(t('accountPlan', { plan: view.plan }))
  if (view.credits !== null) lines.push(t('accountCredits', { credits: view.credits }))
  for (const window of view.windows) {
    let line = t('accountRemaining', {
      window: quotaLabel(window, t),
      percent: Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(window.remainingPercent),
    })
    if (window.resetsAt !== null) {
      line += t('accountResets', { time: localTime(window.resetsAt, locale) })
    }
    lines.push(line)
  }
  return lines
}

export function AccountUsageRow({
  id,
  read,
  links,
  expanded = false,
  t,
}: {
  id: string
  read?: ((id: string, refresh: boolean) => Promise<AcpAccountUsageView>) | undefined
  links?: ReturnType<typeof accountUsageLinks>
  expanded?: boolean
  t: AcpTranslate
}) {
  const [request, setRequest] = useState(0)
  const [view, setView] = useState<AcpAccountUsageView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!read) return
    let active = true
    setBusy(true)
    setFailed(false)
    void read(id, expanded || request !== 0).then(
      (value) => {
        if (active) {
          setView(value)
          setBusy(false)
        }
      },
      () => {
        if (active) {
          setView(null)
          setFailed(true)
          setBusy(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [id, read, expanded, request])

  const websites = links?.map(({ url, site }) =>
    h(
      'a',
      {
        key: url,
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: css.guideLink,
      },
      t(site === 'cn' ? 'accountWebsiteChina' : site === 'intl' ? 'accountWebsiteInternational' : 'accountWebsite'),
    ),
  )
  if (!read || view?.status === 'unsupported' || (!view && !failed)) {
    if (!expanded && !websites?.length) return null
    return h(
      'div',
      { className: css.accountRow, 'data-dsh-acp-account': id },
      expanded && read ? h('span', { role: 'status' }, t(view ? 'accountNotProvided' : 'accountReading')) : null,
      websites,
    )
  }
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || navigator.language
  const lines = view ? accountUsageLines(view, t, locale) : []
  const summary = lines.slice(0, 2).join(' · ')
  const unavailable = failed || view?.status === 'unavailable'
  return h(
    'div',
    { className: css.accountRow, 'data-dsh-acp-account': id },
    expanded && lines.length
      ? h(
          'ul',
          { className: css.accountLines },
          lines.map((line, index) => h('li', { key: index }, line)),
        )
      : lines.length > 2
        ? h(
            'details',
            { className: css.accountDetails },
            h('summary', null, summary, ' · ', t('accountDetails')),
            h(
              'ul',
              null,
              lines.slice(2).map((line, i) => h('li', { key: i }, line)),
            ),
          )
        : summary
          ? h('span', null, summary)
          : null,
    view?.status === 'signin-required'
      ? h('span', { role: 'status' }, t('accountSignIn'))
      : unavailable
        ? h('span', { role: 'status' }, t('accountUnavailable'))
        : null,
    view?.provider === 'antigravity' && view.checkedAt !== null && lines.length > 0
      ? h(
          'time',
          { dateTime: new Date(view.checkedAt).toISOString(), className: css.hint },
          t('accountAsOf', { time: localTime(view.checkedAt, locale) }),
        )
      : null,
    h(
      Button,
      {
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => setRequest((previous) => previous + 1),
        'aria-label': t(view?.status === 'available' ? 'accountCheck' : 'accountRefresh'),
      },
      t(busy ? 'accountReading' : view?.status === 'available' ? 'accountCheck' : 'accountRefresh'),
    ),
    websites,
  )
}
