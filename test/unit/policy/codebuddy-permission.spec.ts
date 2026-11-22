import { expect, it, vi } from 'vitest'
import { ApprovalReviewScope } from '../../../src/host/approval-review/scope.ts'
import {
  createAcpNativePermissionHandler,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpPermissionQuestionService } from '../../../src/domain/policy/elicitation.ts'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

it.each(['registered', 'manual profile'])(
  'retains CodeBuddy’s original once, always and reject choices for %s',
  async (source) => {
    const profile = {
      name: 'CodeBuddy',
      command: 'codebuddy',
      args: ['--acp'],
      env: {},
      ...(source === 'registered' ? { runtime: 'codebuddy' as const } : {}),
    }
    const request: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: {
        toolCallId: 'write',
        _meta: { 'codebuddy.ai/toolName': 'Write' },
        rawInput: { file_path: 'note.txt', content: 'test' },
      },
      options: [
        { name: 'Always allow', kind: 'allow_always', optionId: 'allow_always' },
        { name: 'Allow this time', kind: 'allow_once', optionId: 'allow' },
        { name: 'Reject', kind: 'reject_once', optionId: 'reject' },
      ],
    }
    const spawn = vi.fn(() => {
      throw Error('unexpected inference')
    })
    const owner = {}
    const ask = vi.fn<AcpPermissionQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Reject'] }],
    }))
    const records: AcpPermissionAuditRecord[] = []
    const scope = new ApprovalReviewScope('work', spawn, vi.fn())
    scope.configure(profile, 'hy4flash-free')
    try {
      expect(scope.enabled).toBe(false)
      const response = await scope.handle(
        profile,
        {
          task: () => 'write a note',
          toolCall: request.toolCall,
          humanOnly: false,
          agent: null,
          current: () => true,
        },
        'en',
        new AbortController().signal,
        (deps, signal) =>
          createAcpNativePermissionHandler({
            ...deps,
            permissionProfile: 'codebuddy',
            getAgent: () => owner,
            permissionQuestions: { ask },
            audit: {
              append: async (record) => {
                records.push(record)
              },
            },
          })(request, signal),
      )
      expect(ask).toHaveBeenCalledOnce()
      expect(response.outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
      expect(spawn).not.toHaveBeenCalled()
      expect(records.map((r) => r.data.phase)).toEqual(['asked', 'decided'])
    } finally {
      await scope.close()
    }
  },
)
