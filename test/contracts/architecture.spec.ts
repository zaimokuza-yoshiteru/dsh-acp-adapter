// architecture.spec.ts — 分层重构的依赖方向守卫：把「层」与「允许的跨层边」
// 钉成可执行断言，任何新增违规 import 都会在此变红。
//
// 层划分（src/ 下，按路径前缀归类）：
//   hostCompat       src/host-compat/**        —— 宿主兼容岛（vendor/窄化/fail-closed，不得出岛）
//   runtime          src/runtime/**            —— 进程/超时/stderr 等无协议语义的运行时件
//   protocol         src/protocol/**           —— ACP 协议半（连接、翻译、命令；可依赖 runtime）
//   domainPolicy     src/domain/policy/**      —— 审批桥、审计载荷、原生访问启动策略
// domainObservability src/domain/observability/** —— 结构化日志包装与内存指标
//                                             registry（零 import 叶子，各层可向下消费）
//   domainSession    src/domain/session/**     —— AcpAgent、resume、options-sync、agent 配置 datum
//   persistence      src/persistence/**        —— sidecar 旁路存储
// contract src/contract/** —— dshAcp Remote 的收窄 wire 类型（
//                                             host/client 两半共享的类型真源，零 import 叶子）
//   remote           src/remote/**             —— dshAcp Remote service（health/options/rebindBlank）
//   hostFactory      src/host/factory/**       —— AcpAgentLoop 类（装配全部 domain/infra 件）
//   hostComposition  src/host/composition/**   —— 注册表组合、llm-stub、入口壳
//   hostEntry        src/index.ts              —— 包入口（只允许 re-export hostComposition）
//   clientData       src/client/data/**        —— 面板/选择器纯逻辑（仅可下行 import contract）
// clientCompat src/client/host-compat/** —— client 侧兼容岛（复制壳——
//                                             picker 的 DSH row/popup/command/slot 交互适配；
//                                             只消费 clientData 业务模块，不放 ACP 业务逻辑）
//   clientUi         src/client/ui/**          —— UI 组件与样式（可 import react + 岛的文案类型）
//   clientEntry      src/client/index.ts       —— client 入口
//
// 允许的跨层边（白名单；同层 import 恒允许）：
//   protocol        → runtime
//   domainPolicy    → protocol, runtime, domainObservability
//   domainObservability → （零 import 叶子；observability 内部同层互连恒允许）
//   persistence     → domainPolicy          ← 唯一 sideways 边：sidecar 落盘条目携带
//                                             events.ts 的审计 payload 类型（sidecar 持久化规则），
//                                             persistence 没有自己的协议依赖
//   contract        → （零 import 叶子：wire 类型真源，host 的 remote 与 client 两半
//                       共同下行消费；不进 HOST_LAYERS——它是共享层而非 host 私有）
//   domainSession   → domainPolicy, domainObservability, protocol, runtime, persistence, hostCompat
//   remote          → contract, protocol, runtime, domainSession, domainPolicy,
// domainObservability（起可达 domainPolicy：health 行消费
//                     capability-matrix 零 import 纯函数）
//   hostFactory     → hostComposition, domainSession, domainPolicy, domainObservability, protocol,
//                     runtime, persistence, remote, hostCompat
//   hostComposition → 同 hostFactory（组合根，可指向除 client/contract 外的一切）
//   hostEntry       → hostComposition
//   clientData      → contract
//   clientCompat    → clientData（岛消费业务模块；业务模块不得反向 import 岛）
//   clientUi        → clientData, clientCompat（toolview/dock 引用岛的字典键类型）
//   clientEntry     → contract, clientData, clientUi, clientCompat
//
// 推导出的显式禁令（白名单的必然后果，单列以便报错信息可读）：
//   - hostCompat 不得 import 岛外任何层（vendor 岛自给自足）
//   - runtime / protocol / domain* / persistence / contract / remote 不得 import host/*
//     （hostCompat 是底层兼容岛而非 host 组合层，前缀同形但不在此禁令语义内）
//   - protocol 及以下各层不得 import domain/host/remote（依赖只向下流）
//   - client/* 的相对 import 只允许逃向 src/contract/（共享 wire 类型）；react 只允许出现在
//     clientUi 与 clientCompat（岛承载复制壳 UI 组件）
//   - clientData 只许同层 + contract import、零外部模块（纯逻辑模块直接 vitest 可测）
//
// 实现：fs 直读 src/**/*.ts，正则抽静态 import/export-from 与动态 import 的
// specifier，相对 specifier 解析回 src 相对路径定层后对照白名单。先例：
// test/host-scope.spec.ts 的守卫风格（fs 读 + vitest expect）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, '..', '..', 'src');

// ---------- 层归类 ----------

type Layer =
  | 'hostCompat'
  | 'runtime'
  | 'protocol'
  | 'domainPolicy'
  | 'domainObservability'
  | 'domainSession'
  | 'persistence'
  | 'contract'
  | 'remote'
  | 'hostFactory'
  | 'hostComposition'
  | 'hostEntry'
  | 'clientData'
  | 'clientCompat'
  | 'clientUi'
  | 'clientEntry';

/** src 相对路径 → 层；返回 undefined 表示路径不在任何已知层（归类本身也被钉死）。 */
function layerOf(srcRel: string): Layer | undefined {
  if (srcRel === 'index.ts') return 'hostEntry';
  if (srcRel.startsWith('host-compat/')) return 'hostCompat';
  if (srcRel.startsWith('runtime/')) return 'runtime';
  if (srcRel.startsWith('protocol/')) return 'protocol';
  if (srcRel.startsWith('domain/policy/')) return 'domainPolicy';
  if (srcRel.startsWith('domain/observability/')) return 'domainObservability';
  if (srcRel.startsWith('domain/session/')) return 'domainSession';
  if (srcRel.startsWith('persistence/')) return 'persistence';
  if (srcRel.startsWith('contract/')) return 'contract';
  if (srcRel.startsWith('remote/')) return 'remote';
  if (srcRel.startsWith('host/factory/')) return 'hostFactory';
  if (srcRel.startsWith('host/composition/')) return 'hostComposition';
  if (srcRel === 'client/index.ts' || srcRel.startsWith('client/react.')) return 'clientEntry';
  if (srcRel.startsWith('client/host-compat/')) return 'clientCompat';
  if (srcRel.startsWith('client/data/')) return 'clientData';
  if (srcRel.startsWith('client/ui/')) return 'clientUi';
  return undefined;
}

const HOST_LAYERS: readonly Layer[] = [
  'hostCompat',
  'runtime',
  'protocol',
  'domainPolicy',
  'domainObservability',
  'domainSession',
  'persistence',
  'remote',
  'hostFactory',
  'hostComposition',
  'hostEntry',
];

/** 跨层白名单：key 层可 import 的异层集合（同层恒允许，不入表）。 */
const ALLOWED_CROSS_LAYER: Readonly<Record<Layer, readonly Layer[]>> = {
  hostCompat: [],
  // Native client capabilities expose ACP handlers and durable audit payloads.
  runtime: ['protocol', 'domainPolicy'],
  protocol: ['runtime'],
  domainPolicy: ['protocol', 'runtime', 'domainObservability'],
 // domain/observability 是零 import 叶子（结构化日志包装 + 内存指标）：
  // 各层向下消费它，它自己不依赖任何层。
  domainObservability: [],
  // sidecar 的落盘条目携带 events.ts 审计 payload 类型——persistence 唯一的 sideways 边。
  persistence: ['domainPolicy'],
 // contract 是零 import 叶子：收窄 wire 类型真源，host 的 remote 与
  // client 两半共同下行消费（共享层，不进 HOST_LAYERS）。
  contract: [],
  domainSession: ['domainPolicy', 'domainObservability', 'protocol', 'runtime', 'persistence', 'hostCompat'],
  remote: ['contract', 'protocol', 'runtime', 'domainSession', 'domainPolicy', 'domainObservability'],
  hostFactory: [
    'hostComposition',
    'domainSession',
    'domainPolicy',
    'domainObservability',
    'protocol',
    'runtime',
    'persistence',
    'remote',
    'hostCompat',
  ],
  hostComposition: [
    'hostFactory',
    'domainSession',
    'domainPolicy',
    'domainObservability',
    'protocol',
    'runtime',
    'persistence',
    'remote',
    'hostCompat',
  ],
  hostEntry: ['hostComposition'],
  clientData: ['contract'],
 // client 侧兼容岛：复制壳只消费业务模块，不放 ACP 业务逻辑；
  // 业务模块（clientData）不得反向 import 岛（白名单没有这条边即禁令）。
  clientCompat: ['clientData'],
  clientUi: ['clientData', 'clientCompat'],
  clientEntry: ['contract', 'clientData', 'clientUi', 'clientCompat'],
};

// ---------- import specifier 抽取 ----------

/**
 * 有意逃出 src/ 的相对 import 白名单（钉死精确的 fromFile → specifier 对）。
 * client 入口 value-import 生成的 remote contribution（strict zod codec +
 * TypertRemoteNamespaceMap merge；tsdown 把它内联进 lib/client.js，tsc 经 sibling
 * lib/typert.remote-client.d.ts 拿类型）——src 树外唯一被允许的边。
 */
const ALLOWED_SRC_ESCAPES: Readonly<Record<string, readonly string[]>> = {
  'client/index.ts': ['../../lib/typert.remote-client.js'],
};

const IMPORT_FROM_RE = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;

function specifiersOf(fileText: string): string[] {
  const out: string[] = [];
  for (const m of fileText.matchAll(IMPORT_FROM_RE)) out.push(m[1]!);
  for (const m of fileText.matchAll(DYNAMIC_IMPORT_RE)) out.push(m[1]!);
  for (const m of fileText.matchAll(SIDE_EFFECT_IMPORT_RE)) out.push(m[1]!);
  return out;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

// ---------- 依赖图 ----------

type ImportEdge = {
  /** src 相对路径（posix 分隔符）。 */
  fromFile: string;
  toFile: string;
  fromLayer: Layer;
  toLayer: Layer;
};

type NonRelativeImport = { fromFile: string; specifier: string };

function buildGraph(): { edges: ImportEdge[]; nonRelative: NonRelativeImport[] } {
  const edges: ImportEdge[] = [];
  const nonRelative: NonRelativeImport[] = [];
  for (const abs of walkTsFiles(SRC_DIR)) {
    const fromFile = path.relative(SRC_DIR, abs).split(path.sep).join('/');
    const fromLayer = layerOf(fromFile);
    // 归类白名单本身也被钉死：任何落在已知层之外的文件立刻报错。
    expect(fromLayer, `未归类的 src 文件：${fromFile}`).toBeDefined();
    for (const spec of specifiersOf(fs.readFileSync(abs, 'utf8'))) {
      if (!spec.startsWith('.')) {
        nonRelative.push({ fromFile, specifier: spec });
        continue;
      }
      const toFile = path
        .relative(SRC_DIR, path.resolve(path.dirname(abs), spec))
        .split(path.sep)
        .join('/');
      // 相对 import 不得逃出 src/（client/* 逃进 host 半、或任何 ../.. 越界都会在这里变红）；
      // 唯一例外是 ALLOWED_SRC_ESCAPES 钉死的生成物边（出 src 的目标不参与层归类）。
      if (toFile.startsWith('..')) {
        expect(
          ALLOWED_SRC_ESCAPES[fromFile]?.includes(spec) === true,
          `${fromFile} 的相对 import 逃出 src/：'${spec}'`,
        ).toBe(true);
        continue;
      }
      const toLayer = layerOf(toFile);
      expect(toLayer, `${fromFile} 引用了未归类目标：${toFile}`).toBeDefined();
      edges.push({ fromFile, toFile, fromLayer: fromLayer!, toLayer: toLayer! });
    }
  }
  return { edges, nonRelative };
}

const { edges, nonRelative } = buildGraph();

// ---------- 断言 ----------

describe(' 分层架构守卫', () => {
  it('入口文件存在且各归其位', () => {
    for (const entry of ['index.ts', 'host/composition/index.ts', 'client/index.ts']) {
      expect(fs.existsSync(path.join(SRC_DIR, entry)), `缺失入口：src/${entry}`).toBe(true);
    }
  });

  it('所有跨层 import 都在白名单内', () => {
    const violations = edges
      .filter((e) => e.fromLayer !== e.toLayer)
      .filter((e) => !ALLOWED_CROSS_LAYER[e.fromLayer].includes(e.toLayer))
      .map((e) => `${e.fromFile} (${e.fromLayer}) → ${e.toFile} (${e.toLayer})`);
    expect(violations, `违规跨层边：\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('hostCompat 岛自给自足：不得 import 岛外任何层', () => {
    const violations = edges.filter((e) => e.fromLayer === 'hostCompat' && e.toLayer !== 'hostCompat');
    expect(violations.map((e) => `${e.fromFile} → ${e.toFile}`)).toEqual([]);
  });

  it('host 以下各层不得上行 import host/*', () => {
    // hostCompat 虽以 host- 前缀命名，但它是底层兼容岛而非 host 组合层：
    // domainSession 经白名单可达（agent.ts → host-compat/host-scope.ts），不在此禁令内。
    const violations = edges.filter(
      (e) =>
        e.toLayer.startsWith('host') &&
        e.toLayer !== 'hostCompat' &&
        !e.fromLayer.startsWith('host'),
    );
    expect(violations.map((e) => `${e.fromFile} → ${e.toFile}`)).toEqual([]);
  });

  it('client 半自封闭：client/* 不得 import host 各层', () => {
    const violations = edges.filter(
      (e) => !HOST_LAYERS.includes(e.fromLayer) && HOST_LAYERS.includes(e.toLayer),
    );
    expect(violations.map((e) => `${e.fromFile} → ${e.toFile}`)).toEqual([]);
  });

  it('clientData 除 contract 外不得 import 异层或外部模块（纯逻辑保持同层封闭）', () => {
    const crossLayer = edges.filter(
      (e) => e.fromLayer === 'clientData' && e.toLayer !== 'clientData' && e.toLayer !== 'contract',
    );
    const external = nonRelative
      .filter((i) => layerOf(i.fromFile) === 'clientData')
      .map((i) => `${i.fromFile} import '${i.specifier}'`);
    expect(crossLayer.map((e) => `${e.fromFile} → ${e.toFile}`)).toEqual([]);
    expect(external).toEqual([]);
  });

  it('react 只允许出现在 clientUi 与 clientCompat（兼容岛承载复制壳组件）', () => {
    const violations = nonRelative
      .filter((i) => i.specifier === 'react' || i.specifier.startsWith('react/'))
      .filter((i) => {
        const layer = layerOf(i.fromFile);
        return layer !== 'clientUi' && layer !== 'clientCompat';
      })
      .map((i) => `${i.fromFile} import '${i.specifier}'`);
    expect(violations).toEqual([]);
  });
});
