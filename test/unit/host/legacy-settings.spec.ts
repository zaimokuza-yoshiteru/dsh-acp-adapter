import { mkdtemp, rm, writeFile, rename, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { readLegacyAcpSettings } from '../../../src/host/composition/legacy-settings.ts'

it('reads both sides of the native import rename without rewriting the old configuration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'acp-settings-import-'))
  try {
    expect(await readLegacyAcpSettings(home)).toBeUndefined()
    await writeFile(join(home, 'settings.yaml'), 'dsh-acp:\n  agents:\n    codex:\n      name: Codex\n      command: codex-acp\n')
    const expected = { agents: { codex: { name: 'Codex', command: 'codex-acp', args: [], env: {} } }, searchableModelPicker: false }
    expect(await readLegacyAcpSettings(home)).toEqual(expected)
    await rename(join(home, 'settings.yaml'), join(home, 'settings.yaml.imported'))
    expect(await readLegacyAcpSettings(home)).toEqual(expected)
    await writeFile(join(home, 'settings.yaml'), 'dsh-acp: invalid')
    await expect(readLegacyAcpSettings(home)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('publishes a rehydratable form while keeping host-only Agent validation', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery')
  const { Config } = await import('../../../src/host/composition/config.ts')
  const schema = new z(JSON.parse(JSON.stringify(Config.toJSON())))
  delete schema.dict!.agents!.meta.volatile
  delete schema.dict!.searchableModelPicker!.meta.volatile
  const value = { agents: { codex: { name: 'Codex', command: 'codex-acp', args: [], env: {} } } }
  expect(schema(value)).toEqual({ ...value, searchableModelPicker: false })
  expect(Config(value).agents.get()).toEqual(value.agents)
  expect(Config(value).searchableModelPicker.get()).toBe(false)
  expect(() => Config['~standard'].validate({ agents: { codex: value.agents.codex, second: { ...value.agents.codex, runtime: 'codex' } } })).toThrow('singleton')
  expect(() => Config({ agents: { codex: value.agents.codex, second: { ...value.agents.codex, runtime: 'codex' } } })).toThrow('singleton')
})

it('imports once per installed profile and respects an explicit empty Agent map', async () => {
  const { installLegacySettingsImport } = await import('../../../src/host/composition/legacy-settings.ts')
  const { readdir } = await import('node:fs/promises')
  const { vi } = await import('vitest')
  const home = await mkdtemp(join(tmpdir(), 'acp-settings-lifecycle-'))
  const errors = vi.fn()
  let current: Record<string, unknown> = { searchableModelPicker: true }
  let disposed: () => void = () => {}
  const edit = vi.fn(async (_entry, update: (current: Record<string, unknown>) => Record<string, unknown>) => { current = update(current) })
  const start = (profile: string) => installLegacySettingsImport({
    fiber: { entry: { options: { id: 'dsh-acp-adapter' } } },
    inject: (_keys: string[], setup: (ctx: unknown) => void) => setup({
      effect: (fn: () => () => void) => { disposed = fn() }, root: { loader: { await: async () => {} } },
      profileContext: { home, dir: profile }, configEditor: { edit }, logger: { error: errors },
    }),
  } as never)
  try {
    const legacyText = 'dsh-acp:\n  agents:\n    codex:\n      name: Codex\n      command: codex-acp\n      env:\n        FAKE_TEST_TOKEN: preserved\n'
    await writeFile(join(home, 'settings.yaml'), legacyText)
    start('first')
    await vi.waitFor(async () => expect(await readdir(join(home, 'dsh-acp/settings-imports'))).toHaveLength(1))
    expect(current).toEqual({ searchableModelPicker: true, agents: { codex: { name: 'Codex', command: 'codex-acp', args: [], env: { FAKE_TEST_TOKEN: 'preserved' } } } })
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe(legacyText)
    current = {}; disposed(); edit.mockClear()
    start('first')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(edit).not.toHaveBeenCalled()
    current = { agents: {}, unrelated: 'retain' }; disposed()
    start('second')
    await vi.waitFor(async () => expect(await readdir(join(home, 'dsh-acp/settings-imports'))).toHaveLength(2))
    expect(current).toEqual({ agents: {}, unrelated: 'retain' })
    expect(errors).not.toHaveBeenCalled()
  } finally { disposed(); await rm(home, { recursive: true, force: true }) }
})
