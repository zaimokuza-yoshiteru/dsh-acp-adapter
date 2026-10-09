import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installNativeAgentAccess } from '../../../src/host/composition/native-agent-access.ts'

describe('ACP delegation context at Host request admission', () => {
  it.each(['acp-test', 'deepseek', 'acp-unknown'])(
    'preserves the correct permission guidance through assemble and refresh (%s)',
    async (provider) => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, {})
      let policy = 'before'
      ctx.systemPrompt.variable('provider', () => provider)
      ctx.systemPrompt.context({
        name: 'subagent:delegation',
        order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
        text: 'Native delegated children cannot request interactive approval.',
      })
      ctx.systemPrompt.context({
        name: 'other-plugin',
        order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: () => policy,
      })
      installNativeAgentAccess(ctx, (route) => route === 'acp-test')
      try {
        const accepted = await ctx.systemPrompt.assemble()
        policy = 'after'
        const refreshed = ctx.systemPrompt.refreshContext(accepted)
        expect(refreshed.contexts.find((entry) => entry.name === 'other-plugin')?.text).toBe('after')
        if (provider === 'acp-test') {
          expect(accepted.contexts.find((entry) => entry.name === 'dsh-acp:delegation')?.text).toContain(
            'wait for the host decision before proceeding',
          )
          expect(refreshed.contexts.find((entry) => entry.name === 'dsh-acp:delegation')?.text).toContain(
            'wait for the host decision before proceeding',
          )
          expect(refreshed.contexts.some((entry) => entry.name === 'subagent:delegation')).toBe(false)
          expect(JSON.stringify(refreshed.contexts)).not.toContain('cannot request interactive approval')
        } else {
          expect(refreshed.contexts.find((entry) => entry.name === 'subagent:delegation')?.text).toBe(
            'Native delegated children cannot request interactive approval.',
          )
          expect(refreshed.contexts.some((entry) => entry.name === 'dsh-acp:delegation')).toBe(false)
        }
        const restore = ctx.systemPrompt.suppressRuntimeContext()
        expect(ctx.systemPrompt.refreshContext(accepted).contexts).toEqual([])
        restore()
        const nextRequest = ctx.systemPrompt.refreshContext(await ctx.systemPrompt.assemble())
        expect(nextRequest.contexts).toEqual(refreshed.contexts)
        expect(nextRequest.contexts.filter((entry) => entry.name.endsWith(':delegation'))).toHaveLength(1)
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})
