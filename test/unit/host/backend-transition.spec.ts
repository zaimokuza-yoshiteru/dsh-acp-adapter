import { describe, expect, it } from 'vitest'
import { classifyBackendTransition, hasPriorSemanticHistory } from '../../../src/host/composition/backend-guard.ts'
import type { BackendTransitionInput, ModelSelectionValue } from '../../../src/host/composition/backend-guard.ts'

const native = (provider = 'openai', model = 'model-a'): ModelSelectionValue => ({ provider, model })
const acp = (profile: string, model = 'agent-model'): ModelSelectionValue => ({ provider: `acp-${profile}`, model })

function input(overrides: Partial<BackendTransitionInput>): BackendTransitionInput {
  return {
    lastUsed: null,
    next: native(),
    blank: true,
    hasPriorSemanticHistory: false,
    ...overrides,
  }
}

describe('M6b backend transition classifier', () => {
  it.each([
    ['same native model', native('openai', 'model-a')],
    ['native model change', native('openai', 'model-b')],
    ['native provider change', native('anthropic', 'model-c')],
    ['native with residual ACP binding', native('openai', 'model-d')],
  ])('allows %s without consulting ACP state', (_label, next) => {
    expect(classifyBackendTransition(input({
      lastUsed: native('openai', 'model-a'),
      next,
      bindingProfileId: 'codex',
    }))).toBe('allow-native')
  })

  it('allows a blank session to adopt ACP', () => {
    expect(classifyBackendTransition(input({ next: acp('codex') }))).toBe('allow-blank-acp')
  })

  it('does not adopt ACP when the projection says the session is nonblank', () => {
    expect(classifyBackendTransition(input({
      next: acp('codex'),
      blank: false,
      hasPriorSemanticHistory: true,
    }))).toBe('require-new-session')
  })

  it('allows a same-profile ACP model/reasoning change with a matching binding', () => {
    expect(classifyBackendTransition(input({
      lastUsed: acp('codex', 'model-a'),
      next: acp('codex', 'model-b'),
      blank: false,
      bindingProfileId: 'codex',
    }))).toBe('allow-same-acp')
  })

  it.each([
    ['native to ACP', input({ lastUsed: native(), next: acp('codex'), blank: false })],
    ['ACP to native', input({ lastUsed: acp('codex'), next: native(), blank: false })],
    ['ACP profile change', input({ lastUsed: acp('codex'), next: acp('kimi'), blank: false })],
    ['nonblank without last-used selection', input({ next: acp('codex'), blank: false, hasPriorSemanticHistory: true })],
  ])('requires a new session for %s', (_label, value) => {
    expect(classifyBackendTransition(value)).toBe('require-new-session')
  })

  it.each([
    ['binding missing', undefined],
    ['binding belongs to another profile', 'kimi'],
  ])('reports recovery conflict for same ACP with %s', (_label, bindingProfileId) => {
    const selection: Partial<BackendTransitionInput> = {
      lastUsed: acp('codex'),
      next: acp('codex', 'model-b'),
      blank: false,
      ...(bindingProfileId === undefined ? {} : { bindingProfileId }),
    }
    expect(classifyBackendTransition(input(selection))).toBe('recovery-conflict')
  })

  it('allows native with no last-used selection even when a stale binding is present', () => {
    expect(classifyBackendTransition(input({
      next: native(),
      bindingProfileId: 'codex',
    }))).toBe('allow-native')
  })

  it('does not count the current turn user message as prior history', () => {
    const session = {
      events: [
        { type: 'turn/start', data: {} },
        { type: 'user/message', data: {} },
      ],
    }
    expect(hasPriorSemanticHistory(session as never)).toBe(false)
  })

  it('counts semantic events before the current turn as prior history', () => {
    const session = {
      events: [
        { type: 'turn/start', data: {} },
        { type: 'user/message', data: {} },
        { type: 'turn/start', data: {} },
        { type: 'user/message', data: {} },
      ],
    }
    expect(hasPriorSemanticHistory(session as never)).toBe(true)
  })
})
