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

/** The Host returns decimal strings so a large fixed balance retains its precision. */
function creditBalance(credits: AcpAccountUsageView['credits'], t: AcpTranslate, locale: string): string | null {
  if (credits === null) return null
  if (typeof credits !== 'string')
    return t(credits.kind === 'unlimited' ? 'accountCreditsUnlimited' : 'accountCreditsAvailable')
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
  if (Number(credits) > 0 && Number(credits) < 0.01) return `<${format.format(0.01)}`
  return format.format(credits as Intl.StringNumericLiteral)
}

export function accountUsageSummary(view: AcpAccountUsageView, t: AcpTranslate, locale: string) {
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  return {
    plan: view.plan,
    credits: creditBalance(view.credits, t, locale),
    windows: view.windows.map((window) => ({
      key: window.key,
      label: quotaLabel(window, t),
      value: window.remainingPercent,
      remaining: t('accountRemaining', { percent: percent.format(window.remainingPercent / 100) }),
      reset: window.resetsAt === null ? null : t('accountResets', { time: localTime(window.resetsAt, locale) }),
    })),
  }
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
      expanded && read
        ? h(
            'span',
            { role: 'status' },
            t(view?.provider === 'antigravity' ? 'accountMacTerminal' : view ? 'accountNotProvided' : 'accountReading'),
          )
        : null,
      websites,
    )
  }
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || navigator.language
  const usage = view ? accountUsageSummary(view, t, locale) : null
  const unavailable = failed || view?.status === 'unavailable'
  return h(
    'div',
    { className: css.accountRow, 'data-dsh-acp-account': id },
    usage && (usage.plan || usage.credits)
      ? h(
          'dl',
          { className: css.accountFacts },
          usage.plan ? h('div', null, h('dt', null, t('accountPlan')), h('dd', null, usage.plan)) : null,
          usage.credits ? h('div', null, h('dt', null, t('accountCredits')), h('dd', null, usage.credits)) : null,
        )
      : null,
    usage?.windows.length
      ? h(
          'ul',
          { className: css.quotaWindows },
          usage.windows.map(({ key, label, value, remaining, reset }) =>
            h(
              'li',
              { key },
              h('div', { className: css.quotaHeading }, h('span', null, label), h('span', null, remaining)),
              h('progress', { max: 100, value, 'aria-label': label, 'aria-valuetext': remaining }),
              reset ? h('span', { className: css.hint }, reset) : null,
            ),
          ),
        )
      : null,
    view?.status === 'signin-required'
      ? h('span', { role: 'status' }, t('accountSignIn'))
      : unavailable
        ? h('span', { role: 'status' }, t('accountUnavailable'))
        : null,
    view?.provider === 'antigravity' && view.status === 'ready' && view.checkedAt !== null
      ? h(
          'time',
          { dateTime: new Date(view.checkedAt).toISOString(), className: css.hint },
          t('accountAsOf', { time: localTime(view.checkedAt, locale) }),
        )
      : null,
    !expanded
      ? h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            disabled: busy,
            onClick: () => setRequest((previous) => previous + 1),
            'aria-label': t(view?.status === 'available' ? 'accountCheck' : 'accountRefresh'),
          },
          t(busy ? 'accountReading' : view?.status === 'available' ? 'accountCheck' : 'accountRefresh'),
        )
      : null,
    websites,
  )
}
