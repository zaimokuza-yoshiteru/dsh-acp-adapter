import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'
import { externalAgentApproval } from '../../../src/host/composition/external-agent-approval.ts'
import { createAcpNativePermissionHandler } from '../../../src/domain/policy/permissions.ts'
import {
  observeLiveExternalApprovals,
  type ExternalApprovalObservation,
} from '../../e2e/live-external-approval-observer.ts'
import { acpPermissionAudit } from '../../e2e/acp-permission-audit.ts'

it.each(['allowed-once', 'rejected', 'cancelled'] as const)(
  'observes external %s against durable ACP identity without answering or fabricating native events',
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), 'live-acp-approval-observer-'))
    const ctx = new Context()
    const sidecar = createAcpSidecar({ root })
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      ctx.provide('dshHomePath', (() => root) as never)
      const session = Session.create(SessionId('child'))
      session.append('turn/start', { turn: 1 })
      setApprovalPolicy(session, 'never')
      const agent = { id: session.id, session, ctx, status: 'running' } as Agent
      const host = { ctx }
      const observations: ExternalApprovalObservation[] = []
      const answer = vi.fn(async () => {
        expect(observations.map((event) => event.type)).toEqual(['acp-approval/asked'])
        expect(acpPermissionAudit(host, 'asked')).toHaveLength(1)
        return outcome
      })
      ctx.on('approval/request', answer)
      observeLiveExternalApprovals(host, (id, event) => {
        expect(id).toBe(session.id)
        observations.push(event)
      })
      const handler = createAcpNativePermissionHandler({
        approval: externalAgentApproval(ctx, () => agent),
        getAgent: () => agent,
        audit: { append: (record) => sidecar.append(session.id, record) },
      })
      const response = await handler({
        sessionId: 'acp-child',
        toolCall: { toolCallId: 'shell-1', name: 'bash', kind: 'execute', rawInput: { command: 'marker-command' } },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      })
      expect(answer).toHaveBeenCalledTimes(1)
      expect(response).toEqual({
        outcome:
          outcome === 'cancelled'
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId: outcome === 'allowed-once' ? 'allow' : 'deny' },
      })
      expect(observations.map((event) => event.type)).toEqual(['acp-approval/asked', 'acp-approval/decided'])
      const asked = acpPermissionAudit(host, 'asked')[0]
      const decided = acpPermissionAudit(host, 'decided')[0]
      expect(
        observations.every((event) => event.auditOwner === 'acp-sidecar' && event.data.id === asked?.data.requestId),
      ).toBe(true)
      expect(decided?.data.requestId).toBe(asked?.data.requestId)
      expect(
        session
          .snapshotEvents()
          .filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided'),
      ).toEqual([])
      expect(ctx.approval.overrideOf(session)).toBe('never')
      // A native DSH escalation is rejected by its own service without entering
      // the public answerer; the external observer must not invent an ask for it.
      expect(await ctx.approval.request({ agent, toolName: 'native-bash' })).toBe('rejected')
      expect(observations).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      await sidecar.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
