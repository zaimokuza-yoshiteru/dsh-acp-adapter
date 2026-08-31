// bypass-api.spec.ts — 「插件旁路 API」的可执行回归门。
//
// 由消除满足：插件不拥有任何 HTTP/网络服务面——全部宿主交互只经 typert
// typed Remote（strict descriptor 预生成，gateway 经 /api 信任围栏派发，承担
// loopback/same-origin/CSRF 防线）； webServer 旁路路由已删除。本套件把
// 这条结构性事实钉成可执行断言，任何旁路面回归都会在此变红：
//
//   1. 零 HTTP 面：src/ 全域无 createServer / .listen( / fetch( /
//      XMLHttpRequest，也无 node:http(s)/node:net import（剥注释后扫描，
//      注释提及不误伤）；
//   2. Remote 调用面钉版：src/remote/service.ts 的 @Remote 装饰器只暴露当前
//      additive health/backend/audit/activity/recovery/session-control surface——
//      「写接口集合」即此清单，与 test/integration/host/health.spec.ts 的 typert 生成物钉版
//      双侧对齐，新增/改名/删除必须两侧同步；
//   3. wire 类型收窄钉版：src/contract/remote.ts（零 import 叶子，strict codec
//      生成输入）的字段词表不含 `_meta` 与任何 credential 形态键
//      （token/secret/password/credential/apiKey/authorization/env…），且无
//      `unknown` 字段——SDK 的 `_meta?: Record<string, unknown>` 永不过线
//      （数据最小化 + strict boundary 前提，见 contract/remote.ts 模块头）。
//
// 先例：test/contracts/architecture.spec.ts 的 fs 直读 + vitest expect 守卫风格。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, '..', '..', 'src');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/** 剥注释后的源码（块注释 + 行注释；键名/词表扫描在剥净文本上进行，注释提及不误伤）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 旁路面原语词表（任一命中即 回归）。 */
const HTTP_SURFACE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['createServer', /\bcreateServer\b/],
  ['.listen(', /\.listen\s*\(/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['node:http(s)/node:net import', /from\s+['"]node:(?:https?|net)['"]/],
];

/** 钉版的完整 Remote invocation 集合。 */
const PINNED_REMOTE_METHODS: readonly string[] = [
  'activityFollow',
  'activityPage',
  'activitySnapshot',
  'agentSessionSnapshot',
  'auditTimeline',
  'backendOf',
  'boundSessions',
  'health',
  'ownedProviderRoutes',
  'projectedSubagentIds',
  'rebindRecoveryBlank',
  'recoverySnapshot',
  'retryOriginal',
  'setAgentSessionOption',
];

describe(' 旁路 API 消除门', () => {
  it('src/ 全域无 HTTP/网络服务面原语（插件零 HTTP surface，fetch 也不过线）', () => {
    const violations: string[] = [];
    for (const abs of walkTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, abs).split(path.sep).join('/');
      const text = stripComments(fs.readFileSync(abs, 'utf8'));
      for (const [label, pattern] of HTTP_SURFACE_PATTERNS) {
        if (pattern.test(text)) violations.push(`${rel}: ${label}`);
      }
    }
    expect(violations, `旁路 API 回归：\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('Remote 调用面钉版：@Remote 装饰器只暴露当前公开面（无旁路增删）', () => {
    const text = stripComments(fs.readFileSync(path.join(SRC_DIR, 'remote', 'service.ts'), 'utf8'));
    const named = [...text.matchAll(/@Remote\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
    const streamed = [...text.matchAll(/@Remote\(\s*\{\s*mode:\s*['"]stream['"]\s*\}\s*\)\s*\n\s*async\s+\*\s*(\w+)/g)].map((m) => m[1]!);
    // 裸 @Remote：方法名即 invocation 名（health）
    const bare = [...text.matchAll(/@Remote\s*\n\s*async\s+(\w+)/g)].map((m) => m[1]!);
    expect([...named, ...bare, ...streamed].sort()).toEqual([...PINNED_REMOTE_METHODS].sort());
  });

  it('wire 类型收窄钉版：contract 无 _meta/credential 形态字段、无 unknown 字段', () => {
    const text = stripComments(fs.readFileSync(path.join(SRC_DIR, 'contract', 'remote.ts'), 'utf8'));
    // 字段声明形态的词表（`key?:` / `key:`）；authMethods 等合法键不被 \b 词边界误伤
    const forbiddenKey = /\b(?:_meta|token|accessToken|refreshToken|apiKey|secret|password|credential|credentials|authorization|env)\s*\??\s*:/;
    const hits = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => forbiddenKey.test(line));
    expect(hits, `contract/remote.ts 出现 credential 形态字段：\n  ${hits.join('\n  ')}`).toEqual([]);
    // `unknown` 被 strict boundary 拒绝（生成前提）：wire 类型里不得出现
    expect(/:\s*unknown\b/.test(text), 'contract/remote.ts 出现 unknown 字段类型').toBe(false);
  });
});
