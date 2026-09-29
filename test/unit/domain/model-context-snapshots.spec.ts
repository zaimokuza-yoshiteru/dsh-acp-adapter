import { describe, expect, it } from 'vitest'
import { currentModelContextSnapshots } from '../../../src/domain/session/model-context-snapshots.ts'

const snapshot = (id: string, kind: string, text: string, role = 'user') => ({
  id,
  role,
  source: { kind, ...(kind === 'skill-catalog' ? { form: 'catalog', entries: [] } : {}) },
  content: [{ type: 'text', text }],
})

describe('currentModelContextSnapshots', () => {
  it('selects only the latest allow-listed current snapshots', () => {
    expect(
      currentModelContextSnapshots([
        snapshot('old', 'skill-catalog', 'Old skills'),
        snapshot('ordinary', 'user', 'Prior user request'),
        snapshot('new', 'skill-catalog', 'Current skills'),
        snapshot('runtime', 'runtime-context', 'Current mode'),
      ]),
    ).toEqual([
      { source: 'runtime-context', id: 'runtime', text: 'Current mode' },
      { source: 'skill-catalog', id: 'new', text: 'Current skills' },
    ])
  })

  it('treats an empty clear marker as current and never falls back past malformed latest state', () => {
    expect(
      currentModelContextSnapshots([
        snapshot('old', 'skill-catalog', 'Secret old skill'),
        snapshot('clear', 'skill-catalog', 'No skills are currently available.'),
        snapshot('old-runtime', 'runtime-context', 'Old context'),
        { id: 'bad', role: 'user', source: { kind: 'runtime-context' }, content: [] },
      ]),
    ).toEqual([{ source: 'skill-catalog', id: 'clear', text: 'No skills are currently available.' }])
  })

  it('does not infer skill availability from ordinary tools or malformed source data', () => {
    expect(
      currentModelContextSnapshots([
        snapshot('tool', 'tool-schema', 'skill'),
        snapshot('wrong-role', 'skill-catalog', 'No authority', 'system'),
      ]),
    ).toEqual([])
  })

  it('omits a retained catalog when the current scoped skill entry point is disabled', () => {
    expect(
      currentModelContextSnapshots(
        [
          snapshot('old', 'skill-catalog', 'Retained old skill'),
          snapshot('runtime', 'runtime-context', 'Current mode'),
        ],
        false,
      ),
    ).toEqual([{ source: 'runtime-context', id: 'runtime', text: 'Current mode' }])
  })
})
