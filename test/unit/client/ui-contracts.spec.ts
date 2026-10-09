import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { uiCopyIssues, uiStyleIssues } from './ui-contract-scan.ts'

const client = fileURLToPath(new URL('../../../src/client', import.meta.url))
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })

describe('plugin UI contracts', () => {
  it.each([
    `import { createElement as h } from 'react'; h('button', { 'aria-label': 'Close dialog' }, 'Close')`,
    `import * as R from 'react'; R.createElement('button', null, 'Close')`,
    `const C = () => <button aria-label="Close dialog">Close</button>`,
    `import { createElement as h } from 'react'; const label = 'Close'; h('button', null, label)`,
    `import { createElement as h } from 'react'; function copy(t, key, fallback) { const result = t?.(key); return result || fallback }; h('button', null, copy(t, 'close', 'Close dialog'))`,
    `import { createElement as h } from 'react'; const copy = (key, fallback) => t?.(key) ?? fallback; const labels = () => ({ copyValue: copy('copy', 'Copy value') }); h(JsonTree, { labels: labels() })`,
    `import { createElement as h } from 'react'; h('p', null, ok ? t('ready') : 'Could not load')`,
    `import { createElement as h } from 'react'; h('p', null, t('ready', { reason: 'Could not load' }))`,
    `import { createElement as h } from 'react'; const t = () => 'Close dialog'; h('p', null, t())`,
    `import { createElement as h } from 'react'; const items = [{ id: 'close', label: 'Close dialog' }]; h(Menu, { items })`,
    `import { createElement as h } from 'react'; function props(label) { return { label } }; h(Button, props('Close dialog'))`,
    `const label = 'Close dialog'; const C = () => <button aria-label={label} />`,
  ])('rejects embedded copy reaching a display sink: %s', (source) => {
    expect(uiCopyIssues(source).length).toBeGreaterThan(0)
  })

  it('does not mistake keys, protocol data, identifiers or command examples for product copy', () => {
    expect(
      uiCopyIssues(`
      import { createElement as h } from 'react'
      const labels = [['issues', 'auditIssues'], ['operations', 'auditOperations']]
      const wire = { method: 'session/new', status: 'running' }
      const diagnostics = { message: 'source model restore failed' }
      const manifest = { description: 'Agent supplied description' }
      const text = (t, status) => status === 'running' ? t('running') : status
      h('div', { role: 'dialog', 'data-status': 'running', 'aria-label': t('title') },
        labels.map(([value, key]) => h('button', { key: value }, t(key))),
        text(t, wire.status), agent.name, agent.description, ' · ', 123)
      h(Input, { placeholder: 'devin', label: t('executable') })
      function factory(h) { h('p', { label: 'Not React or UI' }, 'Protocol data') }
      const C = () => <div className={'node'} data-status={'running'} />
    `),
    ).toEqual([])
  })

  it('follows relative-import label helpers across the actual plugin module boundary', () => {
    const helper = fileURLToPath(new URL('./probe-labels.ts', import.meta.url))
    const caller = fileURLToPath(new URL('./probe-view.ts', import.meta.url))
    const source = `import { createElement as h } from 'react'; import { labels } from './probe-labels.ts'; h(JsonTree, { labels: labels(t) })`
    expect(
      uiCopyIssues(
        source,
        caller,
        new Map([
          [
            helper,
            `export function labels(t) { const text = (key, fallback) => t?.(key) ?? fallback; return { copyValue: text('copy', 'Copy value') } }`,
          ],
        ]),
      ).map((issue) => issue.text),
    ).toEqual(['Copy value'])
    expect(
      uiCopyIssues(
        source,
        caller,
        new Map([[helper, `export function labels(t) { return { copyValue: t('copy') } }`]]),
      ),
    ).toEqual([])
  })

  it.each([
    '.button:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }',
    '.button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); }',
    '.card { border-radius: 12px; }',
    '.card { border-radius: var(--dsw-radius-typo); }',
    '.icon { border-radius: 50%; }',
    '.issue { border: 1px solid var(--dsw-alias-border-l2); }',
    '@media (max-width: 400px) { .card { border-radius: 12px; } }',
    '.line { height: 1px; background: var(--dsw-alias-border-l2); }',
    '.issue { border-width: 1px; border-style: solid; border-color: var(--dsw-alias-border-l2); }',
  ])('rejects a theme contract regression: %s', (source) => {
    expect(uiStyleIssues(source).length).toBeGreaterThan(0)
  })

  it('preserves native focus geometry, warning cards, drawings, layout tokens and typography', () => {
    expect(
      uiStyleIssues(`
      .dense:focus-visible { box-shadow: inset 0 0 0 1px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
      .card { border: 1px solid var(--dsw-alias-state-warn-secondary); box-shadow: var(--dsw-shadow-lv2); border-radius: var(--dsw-radius-xl); font-size: 15px; line-height: 24px; }
      .icon { border-radius: 50%; corner-shape: round; }
      .tiny { border-radius: 3px; }
      .inset { border-radius: calc(var(--dsw-radius-lg) - 8px); }
      .pill { border-radius: 999px; corner-shape: round; }
      .issue { border: .5px solid var(--dsw-alias-border-l2); }
      .code { font-family: var(--ds-font-family-code, monospace); }
      .dock { max-width: var(--dsh-chat-content-width, 960px); }
    `),
    ).toEqual([])
  })

  it('checks the entire plugin UI stylesheet corpus in ordinary CI and prepack', () => {
    const styles = files(client).filter((file) => file.endsWith('.css'))
    expect(styles.length).toBeGreaterThan(0)
    expect(
      styles.flatMap((file) =>
        uiStyleIssues(readFileSync(file, 'utf8')).map((issue) => `${relative(client, file)}: ${issue}`),
      ),
    ).toEqual([])
  })

  it('checks rendered copy without scanning dictionaries or agent manifests as prose', () => {
    const sources = files(client).filter(
      (file) => /\.[cm]?tsx?$/.test(file) && !file.endsWith('.d.ts') && basename(file) !== 'locales.ts',
    )
    expect(sources.length).toBeGreaterThan(0)
    const corpus = new Map(sources.map((file) => [file, readFileSync(file, 'utf8')]))
    expect([
      ...new Set(
        sources.flatMap((file) =>
          uiCopyIssues(corpus.get(file)!, file, corpus).map(
            (issue) => `${relative(client, issue.file)}:${issue.line}: ${issue.text}`,
          ),
        ),
      ),
    ]).toEqual([])
  })
})
