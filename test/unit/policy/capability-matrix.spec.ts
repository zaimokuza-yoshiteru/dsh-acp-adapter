// capability-matrix.spec.ts — 端到端能力矩阵纯函数
// （src/domain/policy/capability-matrix.ts）的真值表：
//   行集/顺序恒定（九广告行）；每行三列事实齐备；
//   广告门控行（loadSession/sessionList/sessionClose/sessionDelete）：
//     advertised true → supported；false → unsupported（close/delete 带进程
//     拆除兜底 note）；null（无握手数据）→ unsupported + 统一未知说明；
//   promptImage：Agent 广告与 DSH attachment seam 同时在场才 supported；
//   promptAudio/promptEmbeddedContext：当前没有端到端桥，恒 unsupported；
//   mcpHttp/mcpSse：profile 已配置且 Agent 广告时 supported；
//   caps 为 null 时矩阵不空缺：广告列全 null，status 按 adapter/host 事实照给。

import { describe, expect, it } from 'vitest';
import { acpCapabilityMatrix } from '../../../src/domain/policy/capability-matrix.ts';
import type { AcpCapabilityAdvertisement, AcpCapabilityMatrixRow, AcpSandboxPostureFact } from '../../../src/domain/policy/capability-matrix.ts';

/** 全广告的能力事实（mock happy 形态）。 */
const ALL_ADVERTISED: AcpCapabilityAdvertisement = {
  loadSession: true,
  sessionList: true,
  sessionClose: true,
  sessionDelete: true,
  promptImage: true,
  promptAudio: true,
  promptEmbeddedContext: true,
  mcpHttp: true,
  mcpSse: true,
};

/** 全不广告的能力事实。 */
const NONE_ADVERTISED: AcpCapabilityAdvertisement = {
  loadSession: false,
  sessionList: false,
  sessionClose: false,
  sessionDelete: false,
  promptImage: false,
  promptAudio: false,
  promptEmbeddedContext: false,
  mcpHttp: false,
  mcpSse: false,
};

const SANDBOX_FULL: AcpSandboxPostureFact = { platform: 'darwin', enforcement: 'full', note: null };

function rowOf(rows: readonly AcpCapabilityMatrixRow[], id: string): AcpCapabilityMatrixRow {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`matrix row missing: ${id}`);
  return row;
}

describe('acpCapabilityMatrix（端到端能力矩阵）', () => {
  it('行集与顺序恒定：九个协议能力行；每行三列事实齐备', () => {
    const rows = acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL);
    expect(rows.map((row) => row.id)).toEqual([
      'loadSession',
      'sessionList',
      'sessionClose',
      'sessionDelete',
      'promptImage',
      'promptAudio',
      'promptEmbeddedContext',
      'mcpHttp',
      'mcpSse',
    ]);
    for (const row of rows) {
      expect(row.adapterPath, row.id).not.toBe('');
      expect(row.hostSeam, row.id).toBeNull();
    }
  });

  it('广告门控行：advertised true → supported；false → unsupported', () => {
    const supported = acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL);
    for (const id of ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete']) {
      expect(rowOf(supported, id).status, id).toBe('supported');
    }
    const unsupported = acpCapabilityMatrix(NONE_ADVERTISED, SANDBOX_FULL);
    for (const id of ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete']) {
      expect(rowOf(unsupported, id).status, id).toBe('unsupported');
    }
    expect(rowOf(unsupported, 'loadSession').adapterPath).toBe('resume-staging');
    expect(rowOf(unsupported, 'sessionList').adapterPath).toBe('resume-precheck');
  });

  it('sessionClose/sessionDelete 未广告：unsupported + 进程拆除兜底 note', () => {
    const rows = acpCapabilityMatrix(NONE_ADVERTISED, SANDBOX_FULL);
    for (const id of ['sessionClose', 'sessionDelete']) {
      const row = rowOf(rows, id);
      expect(row.status).toBe('unsupported');
      expect(row.note).toContain('process teardown');
    }
  });

  it('没有 attachment seam 时图片不冒充可用；audio/embedded context 仍没有端到端桥', () => {
    for (const caps of [ALL_ADVERTISED, NONE_ADVERTISED, null]) {
      const rows = acpCapabilityMatrix(caps, SANDBOX_FULL);
      for (const id of ['promptAudio', 'promptEmbeddedContext']) {
        const row = rowOf(rows, id);
        expect(row.status, `${id} caps=${String(caps === null ? 'null' : 'object')}`).toBe('unsupported');
        expect(row.adapterPath).toBe('text-only-block');
      }
      expect(rowOf(rows, 'promptImage').status).toBe('unsupported');
      expect(rowOf(rows, 'promptImage').adapterPath).toBe('durable-attachment-to-inline-image');
    }
  });

  it('图片能力是 Agent advertisement 与 host attachment seam 的交集', () => {
    const supported = rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL, { imageInput: true }), 'promptImage');
    expect(supported).toMatchObject({ status: 'supported', hostSeam: 'attachments' });
    const noStore = rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL), 'promptImage');
    expect(noStore.note).toContain('attachment storage');
    const notAdvertised = rowOf(acpCapabilityMatrix(NONE_ADVERTISED, SANDBOX_FULL, { imageInput: true }), 'promptImage');
    expect(notAdvertised.status).toBe('unsupported');
    expect(notAdvertised.note).toContain('did not advertise');
    expect(rowOf(acpCapabilityMatrix(null, SANDBOX_FULL, { imageInput: true }), 'promptImage').note).toContain('unknown');
  });

  it('mcpHttp/mcpSse：未配置时不支持，配置且 Agent 广告后支持', () => {
    for (const caps of [ALL_ADVERTISED, NONE_ADVERTISED, null]) {
      const rows = acpCapabilityMatrix(caps, SANDBOX_FULL);
      for (const id of ['mcpHttp', 'mcpSse']) {
        const row = rowOf(rows, id);
        expect(row.status).toBe('unsupported');
        expect(row.note).toContain('no MCP server');
      }
    }
    expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL, { imageInput: false, mcpHttpConfigured: true, mcpSseConfigured: true }), 'mcpHttp').status).toBe('supported');
    expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL, { imageInput: false, mcpHttpConfigured: true, mcpSseConfigured: true }), 'mcpSse').status).toBe('supported');
  });

  it('caps 为 null（未 probe/未握手）：矩阵不空缺，广告列全 null，status 按 adapter/host 事实照给', () => {
    const rows = acpCapabilityMatrix(null, SANDBOX_FULL);
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.advertised, row.id).toBeNull();
    }
    // 广告门控行：未知 → unsupported + 统一未知说明
    for (const id of ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete']) {
      const row = rowOf(rows, id);
      expect(row.status, id).toBe('unsupported');
      expect(row.note, id).toContain('unknown');
    }
    // adapter path 决定的行不受广告数据缺席影响
    expect(rowOf(rows, 'promptImage').status).toBe('unsupported');
  });
});
