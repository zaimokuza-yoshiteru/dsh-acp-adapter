import { expect, it } from 'vitest'
import { reconcileMemberModelView } from '../../../src/client/ui/TeamMemberModelControl.ts'
import type { AcpTeamMemberView } from '../../../src/client/data/acp-remote.ts'

const member = (
  patch: Partial<AcpTeamMemberView> & { modelWritable?: boolean } = {},
): AcpTeamMemberView & { modelWritable?: boolean } => ({
  profileId: 'devin',
  sessionId: 'member-1',
  name: 'Member 1',
  status: 'inactive',
  model: 'model-a',
  description: null,
  ...patch,
})

it('keeps the cached catalog while replacing current, pending and writable facts from ACP metadata refresh', () => {
  const previous = {
    currentModel: 'model-a',
    pendingModel: 'model-b',
    models: [
      { id: 'model-a', name: 'A' },
      { id: 'model-b', name: 'B' },
    ],
    writable: true,
    unavailableReason: 'model-switch' as const,
  }
  const next = reconcileMemberModelView(
    previous,
    member({ model: 'model-c', pendingModel: null, modelWritable: false }),
  )
  expect(next).toEqual({ ...previous, currentModel: 'model-c', pendingModel: null, writable: false })
})

it('publishes first-request model refusal from member facts and clears it only on an explicit null', () => {
  const initial = { currentModel: 'model-a', pendingModel: null, models: [], writable: true }
  const used = reconcileMemberModelView(initial, member({ modelUnavailableReason: 'model-switch' }))!
  expect(used.unavailableReason).toBe('model-switch')
  expect(reconcileMemberModelView(used, member())?.unavailableReason).toBe('model-switch')
  expect(reconcileMemberModelView(used, member({ modelUnavailableReason: null }))).not.toHaveProperty(
    'unavailableReason',
  )
})
