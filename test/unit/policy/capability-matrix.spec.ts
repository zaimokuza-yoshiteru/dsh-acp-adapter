// capability-matrix.spec.ts — 端到端能力矩阵纯函数
// （src/domain/policy/capability-matrix.ts）的真值表：
//   行集/顺序恒定（九广告行 + sandbox host seam 行）；每行三列事实齐备；
//   广告门控行（loadSession/sessionList/sessionClose/sessionDelete）：
//     advertised true → supported；false → unsupported（close/delete 带进程
//     拆除兜底 note）；null（无握手数据）→ unsupported + 统一未知说明；
//   promptImage/promptAudio/promptEmbeddedContext：恒 unsupported（adapter v1
//     仅文本 prompt），advertised=true 时 note 点破「广告了但发送被阻止并解释」；
//   mcpHttp/mcpSse：恒 unsupported + D10 设计决策 note；
//   sandbox：full → supported；partial → degraded（note 带平台）；posture
//     null → degraded「未接线」（advertised 恒 null——非 Agent 广告能力）；
//   caps 为 null 时矩阵不空缺：广告列全 null，status 按 adapter/host 事实照给。

import { describe, expect, it } from 'vitest';
import { acpCapabilityMatrix } from '../../../src/domain/policy/capability-matrix.ts';
import type { AcpCapabilityAdvertisement, AcpCapabilityMatrixRow, AcpSandboxPostureFact } from '../../../src/domain/policy/capability-matrix.ts';
import { pickerCapabilityWords } from '../../../src/client/data/selector-logic.ts';
import { CAPABILITY_FIXTURES } from '../../fixtures/capability-facts.ts';

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
const SANDBOX_PARTIAL: AcpSandboxPostureFact = { platform: 'win32', enforcement: 'partial', note: 'windows-acl 残余风险' };

function rowOf(rows: readonly AcpCapabilityMatrixRow[], id: string): AcpCapabilityMatrixRow {
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`matrix row missing: ${id}`);
  return row;
}

describe('acpCapabilityMatrix（端到端能力矩阵）', () => {
  it('行集与顺序恒定：九广告行 + sandbox 行；每行三列事实齐备', () => {
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
      'sandbox',
    ]);
    for (const row of rows) {
      expect(row.adapterPath, row.id).not.toBe('');
      // 无 host seam 参与的行如实归 null（仅 sandbox 行有）
      expect(row.hostSeam, row.id).toBe(row.id === 'sandbox' ? 'sandbox-enforcement' : null);
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

  it('promptImage/promptAudio/promptEmbeddedContext：广告与否恒 unsupported（adapter v1 仅文本 prompt）', () => {
    for (const caps of [ALL_ADVERTISED, NONE_ADVERTISED, null]) {
      const rows = acpCapabilityMatrix(caps, SANDBOX_FULL);
      for (const id of ['promptImage', 'promptAudio', 'promptEmbeddedContext']) {
        const row = rowOf(rows, id);
        expect(row.status, `${id} caps=${String(caps === null ? 'null' : 'object')}`).toBe('unsupported');
        expect(row.adapterPath).toBe('text-only-block');
      }
    }
  });

  it('端到端能力 核心：advertised=true 时 note 点破「广告了但 v1 文本 only，发送被阻止并解释」；false/null 无此 note', () => {
    const advertised = rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL), 'promptImage');
    expect(advertised.note).toContain('text-only');
    expect(advertised.note).toContain('blocked');
    expect(rowOf(acpCapabilityMatrix(NONE_ADVERTISED, SANDBOX_FULL), 'promptImage').note).toBeUndefined();
    expect(rowOf(acpCapabilityMatrix(null, SANDBOX_FULL), 'promptImage').note).toBeUndefined();
  });

  it('mcpHttp/mcpSse：广告与否恒 unsupported + D10 设计决策 note', () => {
    for (const caps of [ALL_ADVERTISED, NONE_ADVERTISED, null]) {
      const rows = acpCapabilityMatrix(caps, SANDBOX_FULL);
      for (const id of ['mcpHttp', 'mcpSse']) {
        const row = rowOf(rows, id);
        expect(row.status).toBe('unsupported');
        expect(row.note).toContain('D10');
      }
    }
  });

  it('sandbox 行：full → supported（无 note）；partial → degraded 且 note 带平台；posture null → degraded「未接线」', () => {
    expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_FULL), 'sandbox')).toEqual({
      id: 'sandbox',
      advertised: null,
      adapterPath: 'confined-spawn',
      hostSeam: 'sandbox-enforcement',
      status: 'supported',
    });
    expect(rowOf(acpCapabilityMatrix(ALL_ADVERTISED, SANDBOX_PARTIAL), 'sandbox')).toEqual({
      id: 'sandbox',
      advertised: null,
      adapterPath: 'confined-spawn',
      hostSeam: 'sandbox-enforcement',
      status: 'degraded',
      note: 'win32: windows-acl 残余风险',
    });
    const unwired = rowOf(acpCapabilityMatrix(ALL_ADVERTISED, null), 'sandbox');
    expect(unwired.status).toBe('degraded');
    expect(unwired.note).toContain('not wired');
    // partial 无 note 时平台仍带出
    expect(rowOf(acpCapabilityMatrix(null, { platform: 'win32', enforcement: 'partial', note: null }), 'sandbox').note).toBe('win32: partial enforcement');
  });

  it('caps 为 null（未 probe/未握手）：矩阵不空缺，广告列全 null，status 按 adapter/host 事实照给', () => {
    const rows = acpCapabilityMatrix(null, SANDBOX_FULL);
    expect(rows).toHaveLength(10);
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
    expect(rowOf(rows, 'sandbox').status).toBe('supported');
  });
});

// ---------- 与 client picker 三值词镜像的一致性（收尾；共有夹具钉两侧） ----------

describe('picker 三值词镜像 × 能力矩阵一致性（client 不得 import domain，共有夹具防漂移）', () => {
  // 词表对应关系：镜像 word 'supported' ⟺ 矩阵行 status 'supported'；镜像
  // 'notAdvertised'/'unsupported' 都对应矩阵 status 'unsupported'（前者是广告
  // 门控行的未广告形态，后者是 adapter path 决定的恒不支持）。
  for (const caps of CAPABILITY_FIXTURES) {
    it(`夹具一致：${JSON.stringify(caps)}`, () => {
      const rows = acpCapabilityMatrix(caps, SANDBOX_FULL);
      const words = pickerCapabilityWords(caps);
      for (const key of Object.keys(caps) as Array<keyof typeof caps>) {
        const status = rowOf(rows, key).status;
        const word = words[key];
        expect(word === 'supported', `${key}: supported ⟺ matrix supported`).toBe(status === 'supported');
        if (word === 'notAdvertised') {
          expect(status, `${key}: notAdvertised ⟹ matrix unsupported`).toBe('unsupported');
          expect(rowOf(rows, key).advertised, `${key}: notAdvertised ⟹ advertised=false`).toBe(false);
        }
        if (word === 'unsupported') {
          expect(status, `${key}: unsupported ⟹ matrix unsupported`).toBe('unsupported');
        }
      }
    });
  }
});
