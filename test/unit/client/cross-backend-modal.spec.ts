import { expect, it, vi } from 'vitest'
import { CrossBackendModal, crossBackendSelectionLabel } from '../../../src/client/ui/CrossBackendModal.ts'
import {
  ACP_AGENT_MANAGED_MODEL_ID,
  ACP_CURRENT_CONFIG_MODEL_ID,
  acpDeclaredModelRoute,
} from '../../../src/contract/model-selection.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

const t = (key: string, params?: Record<string, string | number>): string =>
  `${key}${params === undefined ? '' : JSON.stringify(params)}`
const selection = { provider: 'acp-custom-route', model: 'internal-model-id' }
const catalog: ModelCatalog = {
  default: selection,
  routableProviders: [selection.provider],
  failures: [],
  groups: [{ id: selection.provider, name: 'Agent Name', models: [{ id: selection.model, name: 'Model Name' }] }],
}

it('shows configured Agent and catalog model names without exposing provider routing IDs', () => {
  expect(crossBackendSelectionLabel(selection, catalog, 'My Agent', t)).toBe('My Agent · Model Name')
  expect(crossBackendSelectionLabel(selection, catalog, undefined, t)).toBe('Agent Name · Model Name')
  expect(crossBackendSelectionLabel(selection, null, undefined, t)).not.toContain(selection.provider)
  expect(crossBackendSelectionLabel({ ...selection, model: ACP_CURRENT_CONFIG_MODEL_ID }, catalog, 'My Agent', t)).toBe(
    'My Agent · agentCurrentConfiguration',
  )
  expect(crossBackendSelectionLabel({ ...selection, model: ACP_AGENT_MANAGED_MODEL_ID }, catalog, 'My Agent', t)).toBe(
    'My Agent · agentManagedModel',
  )
})

it('preserves real Agent model names even when a wire model collides with the current-config sentinel', () => {
  const model = acpDeclaredModelRoute(ACP_CURRENT_CONFIG_MODEL_ID)
  const actualName = 'Agent current configuration'
  expect(
    crossBackendSelectionLabel(
      { ...selection, model },
      {
        ...catalog,
        groups: [{ id: selection.provider, name: 'Agent Name', models: [{ id: model, name: actualName }] }],
      },
      'My Agent',
      t,
    ),
  ).toBe(`My Agent · ${actualName}`)
})

it.each([
  [null, 'crossBackendNewModelSession'],
  ['preset-unavailable', 'independentUseDefault'],
  ['ungrouped-destination', 'unroutedHistoryOpen'],
] as const)('offers the correct destination action after %s', (phase, actionLabel) => {
  const cancel = vi.fn()
  const confirm = vi.fn()
  const coordinator = {
    getSnapshot: () => ({
      pending: {
        reason: 'model-switch',
        failure: phase === null ? null : { phase, message: 'workspace offline' },
        confirmable: true,
        busy: false,
        ticket: { key: 'change', sourceSelection: selection, targetSelection: { ...selection, model: 'new-model' } },
      },
    }),
    subscribe: () => () => {},
    cancel,
    confirm,
  }
  const modal = CrossBackendModal({
    coordinator,
    loadModelCatalog: async () => catalog,
    profileName: () => 'My Agent',
    t,
  } as never) as {
    props: {
      title: string
      description: string
      onClose(): void
      footer: { props: { children: { props: { children: string; onClick(): void } }[] } }
    }
  }
  expect(modal.props.title).toBe('crossBackendModelSwitchTitle')
  expect(modal.props.description).toContain('My Agent')
  expect(modal.props.description).not.toContain(selection.provider)
  const [keep, create] = modal.props.footer.props.children
  expect(keep!.props.children).toBe('crossBackendKeepModel')
  expect(create!.props.children).toBe(actionLabel)
  keep!.props.onClick()
  expect(cancel).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
  create!.props.onClick()
  expect(confirm).toHaveBeenCalledExactlyOnceWith('change', phase === 'preset-unavailable')
})

it('explains that the original Agent must be restored to continue a retired session', () => {
  const modal = CrossBackendModal({
    coordinator: {
      getSnapshot: () => ({
        pending: {
          reason: 'backend-change',
          confirmable: true,
          busy: false,
          failure: null,
          ticket: { key: 'retired', sourceUnavailable: true, targetSelection: selection },
        },
      }),
      subscribe: () => () => {},
    },
    loadModelCatalog: async () => catalog,
    profileName: () => undefined,
    t,
  } as never) as { props: { description: string } }
  expect(modal.props.description).toBe('crossBackendSourceUnavailable')
})

it('offers a blank session or an authorized retry after automatic handoff fails', () => {
  const beginHandoff = vi.fn()
  const confirm = vi.fn()
  let granted = true
  const modal = CrossBackendModal({
    coordinator: {
      getSnapshot: () => ({
        pending: {
          reason: 'backend-change',
          canHandoff: true,
          handoffError: 'handoffSourceBusy',
          confirmable: true,
          busy: false,
          failure: null,
          ticket: {
            key: 'operation',
            sourceSessionId: 's',
            sourceSelection: { provider: 'native', model: 'native-model' },
            targetSelection: selection,
          },
        },
      }),
      subscribe: () => () => {},
      confirm,
      beginHandoff,
    },
    loadModelCatalog: async () => catalog,
    profileName: () => 'My Agent',
    t,
    language: () => 'zh',
    sessionAccessSource: () => ({ getSnapshot: () => granted, subscribe: () => () => {} }),
  } as never) as {
    props: {
      footer: {
        props: {
          children: [
            unknown,
            {
              type: (props: unknown) => {
                props: { label: string; children: { props: { children: { props: { onClick: () => void } } } } }
              } | null
              props: unknown
            },
            { props: { variant: string; children: string; onClick: () => void } },
          ]
        }
      }
    }
  }
  const [, handoff, blank] = modal.props.footer.props.children
  expect(blank.props.variant).toBe('primary')
  expect(blank.props.children).toBe('handoffBlank')
  blank.props.onClick()
  expect(confirm).toHaveBeenCalledExactlyOnceWith('operation', false)
  expect(beginHandoff).not.toHaveBeenCalled()
  const tooltip = handoff.type(handoff.props)!
  expect(tooltip.props.label).toContain('My Agent')
  const button = tooltip.props.children.props.children
  button.props.onClick()
  expect(beginHandoff).toHaveBeenCalledExactlyOnceWith('operation', 'zh')
  granted = false
  button.props.onClick()
  expect(beginHandoff).toHaveBeenCalledTimes(1)
  expect(handoff.type(handoff.props)).toBeNull()
})
