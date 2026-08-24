// probe-cleanup.spec.ts — probe 会话清理的 e2e 钉版：
//
//   - AcpClientConnection.probe：session/new 后、拆除前按 sessionCapabilities 广告
//     做 capability-aware 清理（close 先、delete 后），结果带 cleanup 三态事实；
//     清理失败/未广告不翻转 probe 成败，进程强杀与临时目录删除语义不变。
//   - closeSession/deleteSession typed 方法面：长连接上 close+delete 后
//     session/list 无残留（连续两轮不积累垃圾）。
//   - llm-stub 粒度：invalidateProbe 后重探仍逐个 delete 自己的 probe 会话；
//     cleanup 事实与 capability hash 随 ok 缓存条目保留。
//
// 场景旋钮（mock-agent.mjs）：happy（delete 有、close 无——对齐真机 devin
// 3000.4.25）/ cleanup-close-delete（额外广告 close）/ delete-fail（delete 一律
// -32603）/ no-delete（不广告 delete，-32601）。
//
// 孤儿进程防线：所有 spawn 的 argv 带 SPEC_TAG（含本 worker pid），afterAll 用
// `ps` 全量扫描无残留（llm-stub.spec.ts 同款先例）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpClientConnection } from '../../../src/protocol/v1/connection.ts';
import { AcpStubAdapter } from '../../../src/host/composition/llm-stub.ts';
import type { AcpStubAgentConfig } from '../../../src/domain/session/agent-config.ts';
import type { SubprocessSeam } from '../../../src/runtime/process/subprocess.ts';
import { sharedTestSubprocess } from '../../fixtures/subprocess-seam-testing.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = path.join(TEST_DIR, '..', '..', 'mock-agent', 'mock-agent.mjs');
const SPEC_TAG = `--dsh-acp-cleanup-spec-${process.pid}`;

const PROBE_OPTIONS = { timeoutMs: 5_000, eofGraceMs: 100, termGraceMs: 400 };

let logDir = '';
let subprocess: SubprocessSeam;
let spawnSeq = 0;

beforeAll(async () => {
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-cleanup-spec-'));
  subprocess = (await sharedTestSubprocess()).seam;
});

afterAll(() => {
  const ps = execFileSync('ps', ['-axo', 'args'], { encoding: 'utf8' });
  expect(ps.split('\n').filter((line) => line.includes(SPEC_TAG))).toEqual([]);
  fs.rmSync(logDir, { recursive: true, force: true });
});

interface MockHandle {
  config: AcpStubAgentConfig;
  logPath: string;
}

/** mock agent 的 stub 配置：argv[0] 为绝对路径的 process.execPath，env 全权自带。 */
function mockAgent(scenario: string): MockHandle {
  const seq = ++spawnSeq;
  const logPath = path.join(logDir, `cleanup-${String(seq)}.log`);
  return {
    logPath,
    config: {
      name: 'Mock Agent',
      command: process.execPath,
      args: [MOCK_AGENT_PATH, `${SPEC_TAG}-m${String(seq)}`],
      env: { MOCK_SCENARIO: scenario, MOCK_LOG: logPath },
    },
  };
}

function readLog(logPath: string): string {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

/** 日志中 session/close 与 session/delete 行的次序（不存在归 -1）。 */
function cleanupOrder(logPath: string): { closeAt: number; deleteAt: number } {
  const lines = readLog(logPath).split('\n');
  return {
    closeAt: lines.findIndex((line) => line.includes('session/close')),
    deleteAt: lines.findIndex((line) => line.includes('session/delete')),
  };
}

async function probeMock(scenario: string) {
  const handle = mockAgent(scenario);
  const result = await AcpClientConnection.probe(
    {
      argv: [handle.config.command, ...handle.config.args],
      cwd: os.tmpdir(),
      env: { ...handle.config.env },
      subprocess,
    },
    PROBE_OPTIONS,
  );
  return { result, logPath: handle.logPath };
}

describe('probe 的 capability-aware 会话清理（/probe 清理）', () => {
  it('happy（真机 devin 形态：delete 有、close 无）：close 记 not-advertised，delete 已执行', async () => {
    const { result, logPath } = await probeMock('happy');
    expect(result.cleanup).toEqual({ close: 'not-advertised', delete: 'done' });
    // delete 确实打到了 mock（日志有 session/delete 行）
    expect(readLog(logPath)).toContain(`session/delete ${result.sessionId}`);
  });

  it('cleanup-close-delete（广告 close+delete）：次序 close 先 delete 后，两步均 done', async () => {
    const { result, logPath } = await probeMock('cleanup-close-delete');
    expect(result.cleanup).toEqual({ close: 'done', delete: 'done' });
    const order = cleanupOrder(logPath);
    expect(order.closeAt).toBeGreaterThanOrEqual(0);
    expect(order.deleteAt).toBeGreaterThan(order.closeAt);
  });

  it('no-delete（未广告 delete）：cleanup 记 not-advertised，probe 仍成功（降级事实不翻成败）', async () => {
    const { result, logPath } = await probeMock('no-delete');
    expect(result.cleanup).toEqual({ close: 'not-advertised', delete: 'not-advertised' });
    expect(result.configOptions).toBeDefined();
    // 未广告即不发帧：日志无任何 close/delete 行
    const order = cleanupOrder(logPath);
    expect(order.closeAt).toBe(-1);
    expect(order.deleteAt).toBe(-1);
  });

  it('delete-fail：cleanup 记 failed + 诊断 message；probe 仍成功，进程与临时目录照常回收', async () => {
    const { result, logPath } = await probeMock('delete-fail');
    expect(result.cleanup.close).toBe('not-advertised');
    expect(result.cleanup.delete).toBe('failed');
    expect(result.cleanup.message).toContain('session/delete failed');
    // 临时 cwd 由 probe 自建自删（ownsCwd）：probe 返回后 os.tmpdir 下无本次残留目录
    // （目录名不可见，间接证据 = afterAll 的 ps 无孤儿 + mock 进程已收 SIGTERM 日志）
    expect(readLog(logPath)).toContain('SIGTERM received');
  });
});

describe('closeSession/deleteSession 方法面：session/list 无残留', () => {
  it('长连接上连续两轮 new→close→delete，session/list 始终无残留', async () => {
    const handle = mockAgent('cleanup-close-delete');
    const conn = new AcpClientConnection(
      {
        argv: [handle.config.command, ...handle.config.args],
        cwd: logDir,
        env: { ...handle.config.env },
        subprocess,
      },
      { eofGraceMs: 100, termGraceMs: 400 },
    );
    try {
      await conn.initialize();
      for (let round = 0; round < 2; round += 1) {
        const session = await conn.newSession({ cwd: logDir });
        await conn.closeSession(session.sessionId);
        await conn.deleteSession(session.sessionId);
        const list = await conn.listSessions({ cwd: logDir });
        expect(list.sessions).toEqual([]);
      }
    } finally {
      await conn.close();
    }
  });

  it('delete 的幂等边界：删两次，第二次 -32602 分类为 protocol-error', async () => {
    const handle = mockAgent('happy');
    const conn = new AcpClientConnection(
      {
        argv: [handle.config.command, ...handle.config.args],
        cwd: logDir,
        env: { ...handle.config.env },
        subprocess,
      },
      { eofGraceMs: 100, termGraceMs: 400 },
    );
    try {
      await conn.initialize();
      const session = await conn.newSession({ cwd: logDir });
      await conn.deleteSession(session.sessionId);
      await expect(conn.deleteSession(session.sessionId)).rejects.toMatchObject({ kind: 'protocol-error' });
    } finally {
      await conn.close();
    }
  });
});

describe('llm-stub 粒度：重探不积累 probe 会话', () => {
  it('invalidateProbe 后重探：每个 probe 会话都被 delete（连续刷新无残留），cleanup/hash 随缓存保留', async () => {
    const { config, logPath } = mockAgent('happy');
    const route = 'acp-cleanup-stub';
    const adapter = new AcpStubAdapter({
      agents: () => new Map([[route, config]]),
      probeOptions: PROBE_OPTIONS,
      subprocess: { ok: true, seam: subprocess },
    });
    await adapter.listModels(route);
    adapter.invalidateProbe(route);
    await adapter.listModels(route);
    const log = readLog(logPath);
    // 两次 probe 各建各删：session/new ×2、session/delete ×2
    expect(log.match(/session\/new/g)).toHaveLength(2);
    expect(log.match(/session\/delete mock-session/g)).toHaveLength(2);
    const snapshot = adapter.probeSnapshot(route);
    expect(snapshot?.result.kind).toBe('ok');
    if (snapshot?.result.kind === 'ok') {
      expect(snapshot.result.cleanup).toEqual({ close: 'not-advertised', delete: 'done' });
      // capability hash：16 hex 指纹（agent version 经 agentInfo 已在条目里）
      expect(snapshot.result.capabilityHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
