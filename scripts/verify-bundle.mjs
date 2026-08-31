#!/usr/bin/env node
// 仓外可执行的 0.1.2-alpha.3 client bundle 校验（独立 node 直跑，零依赖）。
// 覆盖：① package.json `dsh.client` manifest 形态与 peer/dev 双列纪律
// ② 产物存在性 ③ 产物闭包（__ModuleLoader__ 包装形态 / id == 包名 /
// sourcemap 在场且 sources 非空）④ module requests（产物内 require 全部落在
// Alpha baseline ∪ dsh.client.external）⑤ 源码消费审计（ctx.get 服务读取必须有
// 模块级 inject 或显式可选登记）⑥ npm tarball 内容精确性（npm pack --dry-run）
// ⑦ 旧接管面产物禁入（synthetic tool / custom picker / old compatibility paths）。
// 规范出处：reference/deepseek-harness packages/client/tsdown.client.ts（preset）、
// packages/client/web/src/platform.ts（baseline）、scripts/verify-client-packages.ts（门禁）。
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findMissingRelativeRuntimeImports } from './verify-runtime-closure.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

/** Alpha baseline module-table rows（platform.ts PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS）。 */
const BASELINE_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

/**
 * baseline 行的 npm 包名（inject 是包名边，PLATFORM_MODULES 包由 shell 隐式播种，点名即冗余）。
 * Alpha 的共享 store 是平台模块，由 DSH web shell 直接播种；插件无需把它放进
 * dsh.client.inject，但如果源码需要 value import，应在 bundle 中保持为外部模块。
 */
const BASELINE_PACKAGES = new Set([
  'react',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
])

/**
 * 可选 cordis 服务读取登记：上游同位插件（ui-model-selection service.ts:88）以
 * ctx.get + undefined 守卫可选读取 conversation（缺席仅降级 composer 阻断，不影响激活），
 * 包级依赖边经 dsh.client.inject 的 @deepseek-ai/dsh-client-ui-conversation 声明。
 * `remote.dshAcp` 是本插件 `$mount` 自挂载的 Remote namespace 服务键（gateway 把它
 * 注册在 client root 的子 fiber 上）。消费 UI 必须在 mount 后通过子 fiber 显式
 * inject；顶层 Loader inject 会提前等待，未声明的直接 property read 则会被 Cordis 拒绝。
 */
const OPTIONAL_SERVICE_READS = new Set(['conversation'])

const failures = []
const fail = (msg) => failures.push(msg)

// ---------------------------------------------------------------------------
// ① manifest：dsh.client 形态 + 依赖区双列
// ---------------------------------------------------------------------------

const client = pkg.dsh?.client
if (typeof client !== 'object' || client === null || Array.isArray(client)) {
  fail('package.json: dsh.client must be an object')
} else {
  if (client.platform !== 'web') fail(`package.json: dsh.client.platform must be "web"; found ${JSON.stringify(client.platform)}`)
  if ('immediately' in client) fail('package.json: dsh.client.immediately 不声明（prefetch 分层是宿主编排，非本包职责）')
  if ('external' in client) checkStringArray('dsh.client.external', client.external)
  checkStringArray('dsh.client.inject', client.inject, { required: true })
}

function checkStringArray(field, value, { required = false } = {}) {
  if (value === undefined) {
    if (required) fail(`package.json: ${field} 缺失（必须完整声明包名依赖边）`)
    return []
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`package.json: ${field} must be a string array`)
    return []
  }
  const seen = new Set()
  for (const item of value) {
    if (item === '') fail(`package.json: ${field} contains an empty value`)
    else if (seen.has(item)) fail(`package.json: ${field} lists ${JSON.stringify(item)} twice`)
    seen.add(item)
  }
  return value
}

const inject = Array.isArray(client?.inject) ? client.inject.filter((item) => typeof item === 'string' && item !== '') : []
const declaredExternal = Array.isArray(client?.external) ? client.external.filter((item) => typeof item === 'string' && item !== '') : []

for (const name of inject) {
  if (BASELINE_PACKAGES.has(name)) {
    fail(`package.json: dsh.client.inject 点名 baseline 包 ${JSON.stringify(name)}；baseline 由 shell 隐式提供（如需类型仅 devDependencies）`)
  }
}

const baselineModuleSet = new Set(BASELINE_MODULES)
for (const spec of declaredExternal) {
  if (baselineModuleSet.has(spec)) {
    fail(`package.json: dsh.client.external repeats baseline module ${JSON.stringify(spec)}; remove the explicit declaration`)
  }
  if (spec === pkg.name || spec === `${pkg.name}/client`) {
    fail(`package.json: dsh.client.external names its own row ${JSON.stringify(spec)}`)
  }
}

// 每个 inject 包名 peerDependencies + devDependencies 双列。 版本策略：
// dev 精确钉最低已验证版本（测试真源可复现），peer 是最低版本制范围
// `>=<dev> <上界`（更高版本不因版本号被拒，运行时结构门兜底）；peer 与 dev
// 精确相同也接受（cordis 等尚未 widen 的条目）。
for (const [name, peerRange] of Object.entries(pkg.peerDependencies ?? {})) {
  const devRange = pkg.devDependencies?.[name]
  if (devRange === undefined) {
    fail(`package.json: peerDependencies.${name} (${peerRange}) 缺少 devDependencies 同名声明`)
  } else if (peerRange !== devRange && peerRange !== `>=${devRange}` && peerRange !== `>=${devRange} <0.2.0` && peerRange !== `>=${devRange} <5.0.0`) {
    fail(`package.json: peerDependencies.${name} is ${peerRange}; expected the exact dev pin or a >=${devRange} minimum-version range; found devDependencies ${devRange}`)
  }
}
for (const name of inject) {
  if (pkg.peerDependencies?.[name] === undefined) {
    fail(`package.json: dsh.client.inject ${JSON.stringify(name)} 必须出现在 peerDependencies（最低版本制范围）`)
  }
}

const clientExport = pkg.exports?.['./client']
if (clientExport?.default !== './lib/client.js') {
  fail('package.json: 声明 dsh.client 必须有 exports["./client"].default == "./lib/client.js"')
}
if (clientExport?.types !== './lib/types/client/index.d.ts') {
  fail('package.json: exports["./client"].types 应为 "./lib/types/client/index.d.ts"')
}
if (pkg.exports?.['.']?.default !== './lib/index.js') {
  fail('package.json: exports["."].default 应为 "./lib/index.js"')
}

// typert Remote 生成物经 public subpath 出场（host face / client contribution；
// typert-loader 按 ./typert 发现 strict descriptor，client 入口 value-import ./remote 实体）。
const typertExport = pkg.exports?.['./typert']
if (typertExport?.default !== './lib/typert.host.js' || typertExport?.types !== './lib/typert.host.d.ts') {
  fail('package.json: exports["./typert"] 应指向 ./lib/typert.host.{js,d.ts}（公开 host 入口）')
}
const remoteExport = pkg.exports?.['./remote']
if (remoteExport?.default !== './lib/typert.remote-client.js' || remoteExport?.types !== './lib/typert.remote-client.d.ts') {
  fail('package.json: exports["./remote"] 应指向 ./lib/typert.remote-client.{js,d.ts}（公开 client contribution）')
}

// zod 是生成物 strict codec 的运行时真源——dependencies 精确钉版（范围前缀
// 会让 codec 行为随宿主解析漂移）。
const zodRange = pkg.dependencies?.zod
if (typeof zodRange !== 'string' || !/^\d+\.\d+\.\d+$/.test(zodRange)) {
  fail(`package.json: dependencies.zod 必须精确钉版（生成物 codec 的运行时真源）；found ${JSON.stringify(zodRange)}`)
}

// ---------------------------------------------------------------------------
// ② 产物存在
// ---------------------------------------------------------------------------

const REQUIRED_ARTIFACTS = [
  'lib/index.js',
  'lib/client.js',
  'lib/client.js.map',
  'lib/types/index.d.ts',
  'lib/types/client/index.d.ts',
  // typert Remote 生成物（scripts/gen-typert.mjs；.d.ts.map 不进 files 是故意的）
  'lib/typert.host.js',
  'lib/typert.host.d.ts',
  'lib/typert.remote-client.js',
  'lib/typert.remote-client.d.ts',
]
for (const rel of REQUIRED_ARTIFACTS) {
  if (!existsSync(join(root, rel))) fail(`产物缺失: ${rel}（先跑 pnpm build）`)
}

// ---------------------------------------------------------------------------
// ③ 产物闭包：包装形态 / id == 包名 / sourcemap
// ---------------------------------------------------------------------------

const bundlePath = join(root, 'lib/client.js')
if (existsSync(bundlePath)) {
  const js = read('lib/client.js')
  // rolldown 会把 banner/intro/footer 作为包装器重排缩进，故按规范化形态断言。
  const banner = js.match(/^window\.__ModuleLoader__\.load\(\{\s*id:\s*("(?:[^"\\]|\\.)*"),\s*factory:\s*\(require\)\s*=>\s*\{/)
  if (banner === null) {
    fail('lib/client.js: 不以 window.__ModuleLoader__.load({ id, factory: (require) => { 包装开头')
  } else {
    const id = JSON.parse(banner[1])
    if (id !== pkg.name) fail(`lib/client.js: 注册 id ${JSON.stringify(id)} !== package.json name ${JSON.stringify(pkg.name)}`)
  }
  if (!js.includes('var module = { exports: {} };') || !js.includes('var exports = module.exports;')) {
    fail('lib/client.js: 缺少 module/exports intro 初始化')
  }
  const stripped = js.replace(/\s*\/\/# sourceMappingURL=client\.js\.map\s*$/, '')
  if (!/\s*return module\.exports;\s*\}\s*\}\s*\);\s*$/.test(stripped)) {
    fail('lib/client.js: 不以 return module.exports; } }); 收尾')
  }
  if (!js.includes('//# sourceMappingURL=client.js.map')) {
    fail('lib/client.js: 缺少 //# sourceMappingURL=client.js.map（sourcemap 必须开启）')
  }

  const mapPath = join(root, 'lib/client.js.map')
  if (existsSync(mapPath)) {
    try {
      const map = JSON.parse(read('lib/client.js.map'))
      if (map.version !== 3) fail(`lib/client.js.map: version 应为 3；found ${JSON.stringify(map.version)}`)
      if (!Array.isArray(map.sources) || map.sources.length === 0) fail('lib/client.js.map: sources 必须为非空数组')
      if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources?.length) {
        fail('lib/client.js.map: sourcesContent 必须与 sources 等长（浏览器侧无 src 树可取）')
      }
    } catch (error) {
      fail(`lib/client.js.map: 不是合法 JSON（${String(error)}）`)
    }
  }

  // -------------------------------------------------------------------------
  // ④ module requests：产物内 require 全部 ∈ baseline ∪ declared externals
  // -------------------------------------------------------------------------
  const requested = new Set()
  for (const match of js.matchAll(/(?<![\w$])require\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g)) {
    requested.add(match[2])
  }
  const allowed = new Set([...BASELINE_MODULES, ...declaredExternal])
  for (const spec of [...requested].sort()) {
    if (!allowed.has(spec)) {
      fail(`lib/client.js: require(${JSON.stringify(spec)}) 不在 Alpha baseline 或 dsh.client.external 内 —— module table 无法应答`)
    }
  }
  console.log(`[verify-bundle] module requests: ${requested.size === 0 ? '(none)' : [...requested].sort().join(', ')}`)

  // The alpha client entry is additive only: stock DSH owns Chat/ModelPicker;
  // this bundle contributes one keyed ACP activity node renderer.
}

// Activity styles are scoped to the keyed renderer and bundled with the client entry.

// ---------------------------------------------------------------------------
// ⑦ 旧接管面不得进入发布产物
// ---------------------------------------------------------------------------

const forbiddenArtifactMarkers = [
  { pattern: 'dsh_acp_external_tool', label: 'synthetic ACP tool' },
  { pattern: 'model-picker', label: 'custom model picker' },
  { pattern: 'host-compat/agent-loop', label: 'old host compatibility AgentLoop' },
  { pattern: 'protocol/v1/translate', label: 'removed protocol translator' },
]
for (const rel of globSync('lib/**/*', { cwd: root, nodir: true })) {
  const absolute = join(root, rel)
  let contents
  try {
    contents = readFileSync(absolute, 'utf8')
  } catch {
    continue
  }
  for (const { pattern, label } of forbiddenArtifactMarkers) {
    if (contents.includes(pattern)) fail(`发布产物 ${rel} 含 ${label} 标记 ${JSON.stringify(pattern)}`)
  }
}

// ---------------------------------------------------------------------------
// ⑤ 源码消费审计：ctx.get/scope.get 服务读取必须有模块级 inject 或可选登记
// ---------------------------------------------------------------------------

const clientIndex = read('src/client/index.ts')
const injectMatch = clientIndex.match(/export const inject = \[([\s\S]*?)\]/)
if (injectMatch === null) {
  fail('src/client/index.ts: 缺少模块级 export const inject（cordis 服务名数组）')
}
const moduleInject = new Set(injectMatch === null ? [] : [...injectMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]))
const serviceReads = new Set()
for (const file of ['src/client/index.ts']) {
  for (const match of read(file).matchAll(/\b(?:ctx|scope)\.get\(\s*'([^']+)'\s*\)/g)) {
    serviceReads.add(match[1])
  }
}
for (const service of [...serviceReads].sort()) {
  if (!moduleInject.has(service) && !OPTIONAL_SERVICE_READS.has(service)) {
    fail(`src/client: ctx.get('${service}') 未在模块级 inject 声明，也不在可选登记（OPTIONAL_SERVICE_READS）内`)
  }
}
console.log(`[verify-bundle] cordis inject: [${[...moduleInject].join(', ')}]; optional reads: [${[...OPTIONAL_SERVICE_READS].join(', ')}]`)

// ---------------------------------------------------------------------------
// ⑥ tarball 内容：npm pack --dry-run --json
// ---------------------------------------------------------------------------

function packDryRun() {
  const cache = mkdtempSync(join(os.tmpdir(), 'dsh-acp-npm-cache-'))
  try {
    return execFileSync('npm', ['--cache', cache, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
}

let packOutput = null
try {
  packOutput = packDryRun()
} catch (error) {
  fail(`npm pack --dry-run --json 执行失败：${String(error).slice(0, 300)}`)
}
if (packOutput !== null) {
  let tar
  try {
    const parsed = JSON.parse(packOutput)
    // npm <= 11 输出数组；npm >= 12 输出以包名为键的对象。
    tar = Array.isArray(parsed) ? parsed[0] : (parsed?.[pkg.name] ?? parsed)
  } catch {
    fail('npm pack --dry-run --json 输出不是合法 JSON')
    tar = null
  }
  if (tar !== null) {
    const actual = new Set((tar.files ?? []).map((file) => file.path.replaceAll('\\', '/')))
    for (const path of actual) {
      if (/^(src|test|scripts)\//.test(path)) fail(`tarball 含开发面路径: ${path}`)
      if (/evidence/i.test(path)) fail(`tarball 含证据目录残留: ${path}`)
      if (/^(tsconfig.*|tsdown\.config|vitest\.config|pnpm-lock|pnpm-workspace|\.nvmrc|AGENTS|ACCEPTANCE)/.test(path)) {
        fail(`tarball 含仓内配置/文档文件: ${path}`)
      }
      if (path.startsWith('lib/client/')) fail(`tarball 含 tsc 版 client 半（浏览器只消费 lib/client.js bundle）: ${path}`)
      if (path.endsWith('.d.ts.map')) fail(`tarball 含 declaration map（不进 payload）: ${path}`)
      if (path.endsWith('.js.map') && path !== 'lib/client.js.map') fail(`tarball 含宿主半 source map（仅 client bundle 需要）: ${path}`)
    }
    for (const required of [...REQUIRED_ARTIFACTS, 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']) {
      if (!actual.has(required)) fail(`tarball 缺少: ${required}`)
    }

    // files 清单与磁盘展开必须精确互等（不允许 files 指向不存在的东西，也不允许漏装）。
    const expected = new Set(['package.json'])
    for (const entry of pkg.files ?? []) {
      if (/[*{[]/.test(entry)) {
        // Windows 上 globSync 返回反斜杠路径；npm 的 tar 清单统一使用正斜杠。
        for (const match of globSync(entry, { cwd: root })) expected.add(match.replaceAll('\\', '/'))
      } else if (existsSync(join(root, entry))) {
        expected.add(entry)
      } else {
        fail(`package.json files 条目 ${JSON.stringify(entry)} 在磁盘上不存在`)
      }
    }
    for (const path of actual) {
      if (!expected.has(path)) fail(`tarball 含 files 清单外文件: ${path}（收窄 files 或删除该产物）`)
    }
    for (const path of expected) {
      if (!actual.has(path)) fail(`files 清单声明了 ${path} 但 tarball 未包含`)
    }
    console.log(`[verify-bundle] tarball files: ${String(actual.size)}`)

    // The package ships host/runtime modules as separate ESM files. A client
    // bundle module-table check cannot catch a missing host relative import;
    // recursively verify every shipped JavaScript artifact against the npm
    // tarball file set before declaring the package installable.
    const runtimeFiles = [...actual].filter((file) => file.endsWith('.js'))
    const missingRuntimeImports = findMissingRelativeRuntimeImports(runtimeFiles, (file) => readFileSync(join(root, file), 'utf8'))
    for (const missing of missingRuntimeImports) {
      fail(`tarball runtime closure missing ${missing.file} → ${missing.specifier} (${missing.resolved})`)
    }
    if (missingRuntimeImports.length === 0) console.log(`[verify-bundle] runtime relative-import closure: ${String(runtimeFiles.length)} JavaScript artifacts checked`)
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`[verify-bundle] FAIL（${String(failures.length)} 项）:`)
  for (const msg of failures) console.error(`  - ${msg}`)
  process.exit(1)
}
console.log('[verify-bundle] OK: manifest / artifacts / closure / module requests / source audit / style pipeline / tarball 全部通过')
