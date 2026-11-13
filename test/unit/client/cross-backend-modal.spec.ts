import { expect, it, vi } from 'vitest'
import { CrossBackendModal, crossBackendSelectionLabel } from '../../../src/client/ui/CrossBackendModal.ts'
import { ACP_CURRENT_CONFIG_MODEL_ID, acpDeclaredModelRoute } from '../../../src/contract/model-selection.ts'
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

it('offers keeping the current model and explicitly creating an independent model-switch session', () => {
  const cancel = vi.fn()
  const confirm = vi.fn()
  const coordinator = {
    getSnapshot: () => ({
      pending: {
        reason: 'model-switch',
        failure: null,
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
  expect(create!.props.children).toBe('crossBackendNewModelSession')
  keep!.props.onClick()
  expect(cancel).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
  create!.props.onClick()
  expect(confirm).toHaveBeenCalledOnce()
})
