import { describe, expect, it } from 'vitest'
import { descriptorOf } from '../../../src/domain/session/agent-config.ts'
import type { AcpStubAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { acpLaunchEnvironment, acpLaunchFingerprint } from '../../../src/domain/session/launch-fingerprint.ts'
import { acpCanonicalHash16 } from '../../../src/persistence/sidecar.ts'

const HOME = '/home/tester'

describe('acpLaunchEnvironment（Native-first）', () => {
  it('native 继承完整宿主环境，profile 显式值最终覆盖', async () => {
    const config: AcpStubAgentConfig = {
      name: 'Custom', command: 'custom-acp', args: [],
      env: { HTTPS_PROXY: 'http://profile-proxy', PROFILE_ONLY: 'yes' },
    }
    await expect(acpLaunchEnvironment({
      config,
      descriptor: undefined,
      dataHomeStrategy: 'native',
      source: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://host-proxy',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GITHUB_TOKEN: 'available-to-trusted-native-agent',
        OMITTED: undefined,
      },
    })).resolves.toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://profile-proxy',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GITHUB_TOKEN: 'available-to-trusted-native-agent',
      PROFILE_ONLY: 'yes',
    })
  })

  it('protected probe 路径仍只继承最小白名单', async () => {
    const config: AcpStubAgentConfig = { name: 'Probe', command: 'probe', args: [], env: {} }
    await expect(acpLaunchEnvironment({
      config,
      descriptor: undefined,
      dataHomeStrategy: 'protected',
      source: { PATH: '/usr/bin', HOME, GITHUB_TOKEN: 'must-not-pass' },
    })).resolves.toEqual({ PATH: '/usr/bin', HOME })
  })

  it('Native connection snapshot includes descriptor aliases and profile overrides exactly once', async () => {
    const config: AcpStubAgentConfig = {
      name: 'Claude', command: 'claude-agent-acp', args: [], runtime: 'claude',
      env: { ANTHROPIC_BASE_URL: 'https://profile.example', PROFILE_ONLY: 'yes' },
    }
    const descriptor = descriptorOf('claude', config)
    await expect(acpLaunchEnvironment({
      config,
      descriptor,
      dataHomeStrategy: 'native',
      source: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://host.example',
        CLAUDE_CODE_EXECUTABLE: '/opt/claude',
      },
    })).resolves.toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'secret',
      ANTHROPIC_BASE_URL: 'https://profile.example',
      CLAUDE_CODE_EXECUTABLE: '/opt/claude',
      PROFILE_ONLY: 'yes',
    })
  })
})

function baseConfig(): AcpStubAgentConfig {
  return {
    name: 'Codex', command: 'codex-acp', args: [],
    env: { ZED_LIKE: '1', ALPHA: '2' }, runtime: 'codex',
  }
}

function baseInput() {
  return {
    profileId: 'codex',
    config: baseConfig(),
    descriptor: descriptorOf('codex', baseConfig()),
    env: { PATH: '/usr/bin' } as Record<string, string | undefined>,
  }
}

describe('acpLaunchFingerprint（Native 会话连续性）', () => {
  it('相同输入恒等，profile、descriptor 或显式配置变化会改变指纹', () => {
    const base = acpLaunchFingerprint(baseInput())
    expect(acpLaunchFingerprint(baseInput())).toEqual(base)
    expect(acpCanonicalHash16(acpLaunchFingerprint({ ...baseInput(), profileId: 'codex-alt' }))).not.toBe(acpCanonicalHash16(base))
    expect(acpCanonicalHash16(acpLaunchFingerprint({ ...baseInput(), descriptor: descriptorOf('kimi', { runtime: 'kimi' }) }))).not.toBe(acpCanonicalHash16(base))
    expect(base.envKeys).toEqual(['ALPHA', 'ZED_LIKE'])
    expect(JSON.stringify(base)).not.toContain('"1"')
  })

  it('不接管 Agent 凭证引用；executable override 只记录存在性', () => {
    const secret = 'sk-test-SECRET-value-never-persisted'
    const config: AcpStubAgentConfig = { name: 'Claude', command: 'claude-agent-acp', args: [], env: {}, runtime: 'claude' }
    const descriptor = descriptorOf('claude', config)
    const withValues = acpLaunchFingerprint({
      profileId: 'claude', config, descriptor,
      env: { ANTHROPIC_API_KEY: secret, CLAUDE_CODE_EXECUTABLE: '/opt/claude/bin/claude' },
    })
    expect(withValues.envRefs).toBeNull()
    expect(withValues.executableOverride).toEqual({ name: 'CLAUDE_CODE_EXECUTABLE', present: true })
    expect(JSON.stringify(withValues)).not.toContain(secret)
    expect(JSON.stringify(withValues)).not.toContain('/opt/claude/bin/claude')
    const withoutValues = acpLaunchFingerprint({ profileId: 'claude', config, descriptor, env: {} })
    expect(acpCanonicalHash16(withValues)).not.toBe(acpCanonicalHash16(withoutValues))
  })

  it('Native 状态目录环境进入指纹，但不保留原始路径', () => {
    const first = acpLaunchFingerprint({
      ...baseInput(),
      env: { HOME, CODEX_HOME: '/home/tester/.codex-a', XDG_STATE_HOME: '/state-a' },
    })
    expect(first.nativeStateEnv).toEqual(expect.arrayContaining([
      { key: 'HOME', present: true, hash16: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { key: 'CODEX_HOME', present: true, hash16: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { key: 'XDG_STATE_HOME', present: true, hash16: expect.stringMatching(/^[0-9a-f]{16}$/) },
      { key: 'KIMI_CODE_HOME', present: false },
    ]))
    expect(JSON.stringify(first)).not.toContain('/home/tester/.codex-a')
    const moved = acpLaunchFingerprint({
      ...baseInput(),
      env: { HOME, CODEX_HOME: '/home/tester/.codex-b', XDG_STATE_HOME: '/state-a' },
    })
    expect(acpCanonicalHash16(first)).not.toBe(acpCanonicalHash16(moved))
  })

  it('无 descriptor 的自定义 profile 仍生成完整、稳定的 Native 指纹', () => {
    const fp = acpLaunchFingerprint({
      profileId: 'plain',
      config: { name: 'Plain', command: 'plain-acp', args: ['--x'], env: {} },
      descriptor: undefined,
      env: {},
    })
    expect(fp).toMatchObject({
      profileId: 'plain', descriptorId: null, adapterVersion: null,
      wrappedCliVersion: null, envRefs: null, executableOverride: null,
    })
    expect(acpCanonicalHash16(fp)).not.toBe(acpCanonicalHash16({ command: 'plain-acp', args: ['--x'], envKeys: [] }))
  })
})
