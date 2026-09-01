// errors.spec.ts — 统一错误 taxonomy 套件：src/protocol/v1/errors.ts 的
// kind → code / kind → category 映射钉版、correlation id 生成规则与检索形状、
// AcpClientError 的三件套（code/category/correlationId）与覆盖路径。

import { describe, expect, it } from 'vitest';
import {
  ACP_ERROR_CODES,
  ACP_ERROR_KIND_CATEGORY,
  AcpClientError,
  newAcpCorrelationId,
} from '../../../src/protocol/v1/errors.ts';
import type { AcpErrorKind } from '../../../src/protocol/v1/types.ts';

const CORRELATION_ID_PATTERN = /^acperr-\d{8}T\d{6}Z-[0-9a-z]+-[0-9a-f]{6}$/;

const ALL_KINDS: readonly AcpErrorKind[] = [
  'spawn-failure',
  'auth_required',
  'timeout',
  'protocol-error',
  'crash',
  'aborted',
];

describe(' 错误 taxonomy', () => {
  it('kind → 稳定 code 映射钉版（turn/end 与 llm-stub 共用同一张表）', () => {
    expect(ACP_ERROR_CODES).toEqual({
      'spawn-failure': 'ACP_SPAWN_FAILURE',
      auth_required: 'ACP_AUTH_REQUIRED',
      timeout: 'ACP_TIMEOUT',
      'protocol-error': 'ACP_PROTOCOL_ERROR',
      crash: 'ACP_CRASH',
      aborted: 'ACP_ABORTED',
    });
  });

  it('kind → taxonomy 分类默认映射钉版', () => {
    expect(ACP_ERROR_KIND_CATEGORY).toEqual({
      'spawn-failure': 'not-installed',
      auth_required: 'auth-required',
      timeout: 'timeout',
      'protocol-error': 'protocol-incompatible',
      crash: 'agent-crash',
      aborted: 'user-rejected',
    });
  });

  it('两张映射表覆盖全部 kind', () => {
    expect(Object.keys(ACP_ERROR_CODES).sort()).toEqual([...ALL_KINDS].sort());
    expect(Object.keys(ACP_ERROR_KIND_CATEGORY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('AcpClientError 携带三件套：code 随 kind、category 默认映射、correlation id 符合形状', () => {
    const error = new AcpClientError('crash', 'boom');
    expect(error.code).toBe('ACP_CRASH');
    expect(error.category).toBe('agent-crash');
    expect(error.correlationId).toMatch(CORRELATION_ID_PATTERN);
  });

  it('details.category 覆盖默认映射（同 kind 不同成因分流：配置类 spawn-failure）', () => {
    const error = new AcpClientError('spawn-failure', 'bad spec', { category: 'config' });
    expect(error.kind).toBe('spawn-failure');
    expect(error.code).toBe('ACP_SPAWN_FAILURE');
    expect(error.category).toBe('config');
  });

  it('details.correlationId 覆盖构造期生成值（重放/对账场景）', () => {
    const error = new AcpClientError('timeout', 'slow', { correlationId: 'acperr-20260820T184752Z-1-abcdef' });
    expect(error.correlationId).toBe('acperr-20260820T184752Z-1-abcdef');
  });

 it('exit/stderrTail/cause 透传行为不变（既有面）', () => {
    const cause = new Error('root');
    const error = new AcpClientError('crash', 'boom', {
      cause,
      exit: { code: 1, signal: null },
      stderrTail: ['last line'],
    });
    expect(error.cause).toBe(cause);
    expect(error.exit).toEqual({ code: 1, signal: null });
    expect(error.stderrTail).toEqual(['last line']);
  });
});

describe(' correlation id', () => {
  it('生成规则确定性：注入 now/random 后 id 逐字节确定', () => {
    const id = newAcpCorrelationId(new Date('2026-08-20T18:47:52.308Z'), Buffer.from('9f3a2b', 'hex'));
    expect(id).toMatch(/^acperr-20260820T184752Z-[0-9a-z]+-9f3a2b$/);
  });

  it('缺省生成：形状匹配且同批生成互不相同（序号+随机防撞）', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newAcpCorrelationId()));
    for (const id of ids) expect(id).toMatch(CORRELATION_ID_PATTERN);
    expect(ids.size).toBe(64);
  });
});
