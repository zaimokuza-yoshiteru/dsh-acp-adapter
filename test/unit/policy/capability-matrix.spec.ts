// capability-matrix.spec.ts — 端到端能力矩阵纯函数
// （src/domain/policy/capability-matrix.ts）的真值表：
//   行集/顺序恒定（九广告行）；每行三列事实齐备；
//   广告门控行（loadSession/sessionList/sessionClose/sessionDelete）：
//     advertised true → supported；false → unsupported（close/delete 带进程
//     拆除兜底 note）；null（无握手数据）→ unsupported + 统一未知说明；
//   promptImage：Agent 广告与 DSH attachment seam 同时在场才 supported；
//   promptAudio/promptEmbeddedContext：当前没有端到端桥，恒 unsupported；
//   mcpHttp/mcpSse：插件不注入 DSH MCP，Agent 广告传输时 degraded；
//   caps 为 null 时矩阵不空缺：广告列全 null，status 按 adapter/host 事实照给。

import { describe, expect, it } from 'vitest';
import { acpCapabilityMatrix } from '../../../src/domain/policy/capability-matrix.ts';
import type { AcpCapabilityAdvertisement, AcpCapabilityMatrixRow } from '../../../src/domain/policy/capability-matrix.ts';

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

function rowOf(rows: readonly AcpCapabilityMatrixRow[], id: string): AcpCapabilityMatrixRow {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`matrix row missing: ${id}`);
  return row;
}

describe('acpCapabilityMatrix（端到端能力矩阵）', () => {
  it('行集与顺序恒定：九个协议能力行；每行三列事实齐备', () => {
    const rows = acpCapabilityMatrix(ALL_ADVERTISED);
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
    const supported = acpCapabilityMatrix(ALL_ADVERTISED);
    for (const id of ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete']) {
      expect(rowOf(supported, id).status, id).toBe('supported');
    }
    const unsupported = acpCapabilityMatrix(NONE_ADVERTISED);
    for (const id of ['loadSession', 'sessionList', 'sessionClose', 'sessionDelete']) {
      expect(rowOf(unsupported, id).status, id).toBe('unsupported');
    }
    expect(rowOf(unsupported, 'loadSession').adapterPath).toBe('resume-staging');
    expect(rowOf(unsupported, 'sessionList').adapterPath).toBe('resume-precheck');
  });

  it('sessionClose/sessionDelete 未广告：unsupported + 进程拆除兜底 note', () => {
    const rows = acpCapabilityMatrix(NONE_ADVERTISED);
    for (const id of ['sessionClose', 'sessionDelete']) {
      const row = rowOf(rows, id);
      expect(row.status).toBe('unsupported');
      expect(row.note).toContain('process teardown');
    }
  });

  it('没有 attachment seam 时图片不冒充可用；audio/embedded context 仍没有端到端桥', () => {
    for (const caps of [ALL_ADVERTISED, NONE_ADVERTISED, null]) {
      const rows = acpCapabilityMatrix(caps);
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
    const supported = rowOf(acpCapabilityMatrix(ALL_ADVERTISED, { imageInput: true }), 'promptImage');
    expect(supported).toMatchObject({ status: 'supported', hostSeam: 'attachments' });
    const noStore = rowOf(acpCapabilityMatrix(ALL_ADVERTISED), 'promptImage');
    expect(noStore.note).toContain('attachment storage');
    const notAdvertised = rowOf(acpCapabilityMatrix(NONE_ADVERTISED, { imageInput: true }), 'promptImage');
    expect(notAdvertised.status).toBe('unsupported');
    expect(notAdvertised.note).toContain('did not advertise');
    expect(rowOf(acpCapabilityMatrix(null, { imageInput: true }), 'promptImage').note).toContain('unknown');
  });

  it('mcpHttp/mcpSse：不把 Agent 的传输广告伪装成 DSH MCP 注入', () => {
    for (const id of ['mcpHttp', 'mcpSse']) {
      expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED), id).status).toBe('degraded');
      expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED), id).adapterPath).toBe('mcpServers-empty');
      expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED), id).note).toContain('not injected');
      expect(rowOf(acpCapabilityMatrix(NONE_ADVERTISED), id).status).toBe('unsupported');
      expect(rowOf(acpCapabilityMatrix(null), id).status).toBe('unsupported');
    }
  });

  it('caps 为 null（未 probe/未握手）：矩阵不空缺，广告列全 null，status 按 adapter/host 事实照给', () => {
    const rows = acpCapabilityMatrix(null);
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
