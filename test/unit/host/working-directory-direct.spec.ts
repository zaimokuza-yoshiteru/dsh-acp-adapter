import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, markAgentLoopRequest, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import { AcpSessionFacts, acpSessionView } from '../../../src/host/composition/session-facts.ts'
import { createAcpSidecar } from '../../../src/persistence/sidecar.ts'

async function drain(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function fixture(fork: boolean, duringPrompt: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-direct-directory-')))
  const original = path.join(root, 'project')
  const target = path.join(root, 'checkout')
  fs.mkdirSync(original)
  fs.mkdirSync(target)
  const sidecar = createAcpSidecar({ root: path.join(root, 'data') })
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: original })
  await ctx.plugin(AcpSessionFacts)
  const session = ctx.sessions.create(SessionId('direct-directory'), { meta: { cwd: original } })
  const notices: unknown[] = []
  const agent = {
    id: session.id,
    session,
    ctx,
    inject: (notice: unknown) => {
      notices.push(notice)
    },
  } as unknown as Agent
  const calls: { kind: string; cwd: string; parent?: string; input?: unknown }[] = []
  let runtimeCount = 0
  const adapter = new AcpProfileAdapter(
    'direct',
    () => ({ name: 'Direct directory fixture', command: 'unused', args: [], env: {} }),
    { ok: true, seam: undefined as never },
    () => acpSessionView(ctx, session),
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    undefined,
    (launch) => {
      const ordinal = ++runtimeCount
      let id = ordinal === 1 ? 'original-agent' : undefined
      const runtime: AcpProfileRuntime = {
        get acpSessionId() {
          return id
        },
        agentInfo: { name: 'fixture', version: '1' },
        agentCapabilities: { sessionCapabilities: { resume: {}, ...(fork ? { fork: {} } : {}) } },
        protocolVersion: 1,
        start: async () => {
          calls.push({ kind: 'new', cwd: launch.cwd })
        },
        restore: async () => 'reused',
        close: async () => {
          calls.push({ kind: 'close', cwd: launch.cwd })
        },
        fork: async (parent, _signal, _expected, beforeDispatch) => {
          await beforeDispatch?.()
          calls.push({ kind: 'fork', cwd: launch.cwd, parent })
          id = 'forked-agent'
          return { sessionId: id }
        },
        prompt: async (input, _update, signal) => {
          calls.push({ kind: 'prompt', cwd: launch.cwd, input })
          if (duringPrompt && ordinal === 1) {
            // The official service entry bypasses tools/pre-execute and tools.guard.
            await ctx.workingDirectory.set(agent, target)
            expect(signal?.aborted).toBe(true)
            return { stopReason: 'cancelled' }
          }
          return { stopReason: 'end_turn' }
        },
      }
      return runtime
    },
    sidecar,
  )
  const request = (turn: number) => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Input ${turn}` }] })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', message, { surfaceOp: 'append' })
    return markAgentLoopRequest({
      provider: 'acp-direct',
      model: 'fixture',
      sessionId: session.id,
      messages: [message],
    })
  }
  return {
    ctx,
    session,
    agent,
    adapter,
    sidecar,
    calls,
    target,
    original,
    notices,
    request,
    close: async () => {
      await adapter.close()
      await ctx.fiber.dispose()
      await sidecar.dispose()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('native workingDirectory.set without a tool call', () => {
  it.each([true, false])('preserves the bound conversation during a running change (fork=%s)', async (fork) => {
    const h = await fixture(fork, true)
    try {
      const result = drain(h.adapter.stream(h.request(1)))
      if (fork) {
        await result
        expect(h.calls.filter((call) => call.kind === 'fork')).toEqual([
          { kind: 'fork', cwd: h.target, parent: 'original-agent' },
        ])
        expect(await h.sidecar.readLatestBinding(h.session.id)).toMatchObject({
          binding: { agentSessionId: 'forked-agent', canonicalCwd: h.target },
        })
      } else {
        await expect(result).rejects.toThrow('cannot fork its conversation')
        expect(await h.sidecar.readRecoveryState(h.session.id)).toMatchObject({
          kind: 'reconciliation-required',
          cause: 'cwd-changed',
        })
        await expect(drain(h.adapter.stream(h.request(2)))).rejects.toMatchObject({ code: 'ACP_RECOVERY_REQUIRED' })
        expect(h.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
      }
      expect(h.calls.filter((call) => call.kind === 'new')).toEqual([{ kind: 'new', cwd: h.original }])
      expect(h.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
      expect(h.ctx.workingDirectory.get(h.session)).toBe(h.target)
      expect(h.notices).toHaveLength(1)
    } finally {
      await h.close()
    }
  })

  it.each([true, false])('gates an idle direct change without inferring a trusted handoff (fork=%s)', async (fork) => {
    const h = await fixture(fork, false)
    try {
      await drain(h.adapter.stream(h.request(1)))
      h.session.append('step/end', { turn: 1, step: 1 })
      h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const binding = await h.sidecar.readLatestBinding(h.session.id)
      await h.ctx.workingDirectory.set(h.agent, h.target)
      await expect(drain(h.adapter.stream(h.request(2)))).rejects.toMatchObject({ code: 'ACP_RECONCILIATION_REQUIRED' })
      expect(await h.sidecar.readRecoveryState(h.session.id)).toMatchObject({
        kind: 'reconciliation-required',
        cause: 'cwd-changed',
      })
      expect(await h.sidecar.readLatestBinding(h.session.id)).toEqual(binding)
      expect(h.calls.filter((call) => call.kind === 'fork')).toHaveLength(0)
      expect(h.calls.filter((call) => call.kind === 'new')).toEqual([{ kind: 'new', cwd: h.original }])
      expect(h.calls.filter((call) => call.kind === 'prompt')).toHaveLength(1)
    } finally {
      await h.close()
    }
  })
})
