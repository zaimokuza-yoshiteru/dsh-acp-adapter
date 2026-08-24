// 模型选择器兼容壳的上游漂移合同。DSH checkout 由 DSH_UPSTREAM_CHECKOUT 指定；
// 本地也会查找仓内或相邻的 reference/deepseek-harness。固定基线为
// dsh-v0.1.1-rc.2（commit b150a551b8）。本套件验证：
//   1. 版本钉：上游包 package.json version === '0.1.1-rc.2'，tag/commit 常量不被改；
//   2. verbatim 沿用机械比对：rowId / selectionOf 函数体（上游 src/client/index.ts
//      ↔ 岛上 popup.ts，双侧 ts.transpileModule 脱类型后 normalizeJs 归一化），
//      INITIAL_DIRECTORY_STATE 初值对象字面量（上游 directory.ts 的
//      createSnapshotStore 初值 ↔ selector-logic.ts 常量）；
// 3. slot contract 结构化钉（替代旧整文件 sha256）：'conversation.input.model'
//      座位的注册形态与 wire 形状——上游 index.ts 的 slots.inject/register 调用
//      形态（name/locale/inject 工厂返回键/组件 ModelSelect）、slots.ts 的
//      ModelSelectInjected 注入面四键类型、ui-conversation 的座位声明
//      （kind 'single' / scope 'session' / owner InputControlOwnerProps）。
//      上游这些结构变动即红，强制 review 后同步本适配器入口 2（src/client/index.ts）。
//   4. 独立脚本钉：scripts/check-upstream-picker-diff.mjs 以同一组检查对配置的
//      checkout exit 0（脚本与本套件任一侧坏掉/漂移都在这里变红；检查清单
//      改动必须双侧同步——双侧钉版纪律）。
//
// 已完全自有（上游不存在，本套件不钉）：filter.ts、live-controller.ts、
// selector-logic.ts 的 filter/pinned/可见性/默认解析族（default.ts + preset-effort.ts
// 族）、live 选项快照类型与解码、披露面板（pickerDegradationsOf 与 ModelPicker
// disclosurePanel）、健康四层（logic.ts healthLayersOf）。
//
// 语义对照（非 verbatim，钉在注释而非断言）：上游 host 端 buildModelCatalog 对单个
// provider 探测失败只记 failures 不拖垮目录（reference/.../packages/host/apiproxy/
// src/api/sessions.ts）；本适配器宿主 composition/llm-stub 同款语义，由
// test/llm-stub.spec.ts 的「失败隔离」用例钉。

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// ---------- 上游 checkout 与本包源码的读取/抽取/归一化（host-compat.spec.ts 同款小工具） ----------

const checkoutCandidates = [
  process.env.DSH_UPSTREAM_CHECKOUT,
  new URL('../../reference/deepseek-harness/', import.meta.url).pathname,
  new URL('../../../reference/deepseek-harness/', import.meta.url).pathname,
].filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
const upstreamCheckout = checkoutCandidates.find((candidate) => fs.existsSync(candidate))
if (upstreamCheckout === undefined) {
  throw new Error(
    '找不到 DSH 上游 checkout；请设置 DSH_UPSTREAM_CHECKOUT，或把 dsh-v0.1.1-rc.2 放在 reference/deepseek-harness',
  )
}
const upstreamCheckoutUrl = pathToFileURL(`${path.resolve(upstreamCheckout)}${path.sep}`)
const UPSTREAM_ROOT = new URL('packages/client/ui-model-selection/', upstreamCheckoutUrl)
const UPSTREAM_TAG = 'dsh-v0.1.1-rc.2'
const UPSTREAM_COMMIT = 'b150a551b8'

function upstreamSrc(relative: string): string {
  return fs.readFileSync(new URL(`src/client/${relative}`, UPSTREAM_ROOT), 'utf8')
}

const UPSTREAM_INDEX = upstreamSrc('index.ts')
const UPSTREAM_DIRECTORY = upstreamSrc('directory.ts')
const UPSTREAM_SLOTS = upstreamSrc('slots.ts')

// 座位声明的宿主侧真源：ui-conversation 的 slot contract 表（与本包同级只读 checkout）。
const UI_CONVERSATION_SLOTS = fs.readFileSync(
  new URL('packages/client/ui-conversation/src/client/contract/slots.ts', upstreamCheckoutUrl),
  'utf8',
)

const SELECTOR_LOGIC_SRC = fs.readFileSync(new URL('../../src/client/data/selector-logic.ts', import.meta.url), 'utf8')
// verbatim popup fork（rowId/selectionOf/optionsOf）收在 client 侧兼容岛。
const POPUP_SRC = fs.readFileSync(new URL('../../src/client/host-compat/model-picker/popup.ts', import.meta.url), 'utf8')

/** 脱类型：与上游构建产物的差距只剩排版/注释（归一化吸收）。 */
function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText
}

/** 具名函数体抽取（括号配平；模板串 ${} 自配平）。 */
function extractFunction(text: string, name: string): string {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text)
  if (match === null) throw new Error(`function not found: ${name}`)
  return extractBlockAt(text, match.index)
}

/** 锚点后首个 `{` 起的对象字面量抽取（两侧锚点文本不同但字面量可比对时用）。 */
function extractObjectLiteral(text: string, anchor: RegExp): string {
  const match = anchor.exec(text)
  if (match === null) throw new Error(`anchor not found: ${anchor}`)
  return extractBlockAt(text, text.indexOf('{', match.index))
}

function extractBlockAt(text: string, start: number): string {
  const open = text.indexOf('{', start)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced block at ${start}`)
}

/**
 * 排版归一化：去注释；统一引号；对象键去引号（`"key":` → `key:`，吸收 transpile
 * 产物差异）；花括号/分号消解为空白；空白与标点间距压平。只保语义 token 流——
 * 两侧同一算法，漂移必然改变 token 流。
 */
function normalizeJs(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'([^'\\\n]*)'/g, '"$1"')
    .replace(/"(\w+)":/g, '$1:')
    .replace(/\s*=>\s*/g, '=>')
    .replace(/[;{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([()\[\],:<>|&!?+*/=-])\s*/g, '$1')
    .trim()
}

/** 空白压平（slot contract 的结构化子串断言用；保留类型/泛型 token 原样）。 */
function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

describe('模型选择器 fork 钉版（上游 ui-model-selection @ dsh-v0.1.1-rc.2, commit b150a551b8）', () => {
  it('版本钉：上游包 version === 0.1.1-rc.2；tag/commit 常量不被改', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('package.json', UPSTREAM_ROOT), 'utf8')) as { name: string; version: string }
    expect(manifest.name).toBe('@deepseek-ai/dsh-client-ui-model-selection')
    expect(manifest.version).toBe('0.1.1-rc.2')
    expect(UPSTREAM_TAG).toBe('dsh-v0.1.1-rc.2')
    expect(UPSTREAM_COMMIT).toBe('b150a551b8')
  })

  it('verbatim：rowId 函数体与上游 index.ts 机械一致', () => {
    const upstream = normalizeJs(extractFunction(transpile(UPSTREAM_INDEX), 'rowId'))
    const ours = normalizeJs(extractFunction(transpile(POPUP_SRC), 'rowId'))
    expect(ours).toBe(upstream)
  })

  it('verbatim：selectionOf 函数体与上游 index.ts 机械一致', () => {
    const upstream = normalizeJs(extractFunction(transpile(UPSTREAM_INDEX), 'selectionOf'))
    const ours = normalizeJs(extractFunction(transpile(POPUP_SRC), 'selectionOf'))
    expect(ours).toBe(upstream)
  })

  it('verbatim：INITIAL_DIRECTORY_STATE 初值 === 上游 directory.ts createSnapshotStore 初值', () => {
    const upstream = normalizeJs(extractObjectLiteral(UPSTREAM_DIRECTORY, /createSnapshotStore<[\s\S]*?>\(\s*/))
    const ours = normalizeJs(extractObjectLiteral(transpile(SELECTOR_LOGIC_SRC), /INITIAL_DIRECTORY_STATE\s*=\s*/))
    expect(ours).toBe(upstream)
  })

  it('slot contract：座位声明——ui-conversation 把 conversation.input.model 声明为 session 作用域 single 座', () => {
    // wire 形状钉：座位的 kind/scope/owner props（InputControlOwnerProps = 只传 locked）。
    // 上游改声明（kind/scope/owner 任一）即红——本适配器入口 2 的 store seat 与
    // inject 工厂按此形态编织（src/client/index.ts）。
    expect(normalizeWs(UI_CONVERSATION_SLOTS)).toContain(
      `'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }`,
    )
  })

  it('slot contract：注册形态——slots.inject/register 的 name/locale/inject 工厂/组件 ModelSelect', () => {
    // 调用形态钉（非整文件字节）：inject 目标座位名 + register 描述对象关键字段。
    expect(UPSTREAM_INDEX).toContain(`slots.inject('conversation.input.model'`)
    const descriptor = normalizeJs(extractObjectLiteral(transpile(UPSTREAM_INDEX), /slots\.register\(\s*/))
    expect(descriptor).toContain('name:"conversation.input.model"')
    expect(descriptor).toContain('locale:NS')
    // inject 工厂按 sessionId 产出注入面：available 门卫 + 共享目录 store +
    // load/select 两个动作（select 带 available 短路）。
    expect(descriptor).toContain('inject:(sessionId)')
    expect(descriptor).toContain('directory:directory.store')
    expect(descriptor).toContain('select:(selection)=>available')
    // 注册的第二位置参数是展示组件 ModelSelect。
    expect(UPSTREAM_INDEX).toMatch(/slots\.register\([\s\S]*,\s*ModelSelect\)/)
  })

  it('slot contract：注入面 ModelSelectInjected 四键类型（上游 slots.ts）', () => {
    // 座位 occupant 的 wire 形状钉：四键及其类型签名（脱类型会抹掉 interface，
    // 故对原文做空白归一化后的结构化子串断言）。
    const face = normalizeWs(UPSTREAM_SLOTS)
    expect(face).toContain('available: boolean')
    expect(face).toContain('directory: SnapshotStore<ModelDirectoryState>')
    expect(face).toContain('load: () => void')
    expect(face).toContain('select: (selection: ModelSelection) => Promise<boolean>')
  })

  it('修改型 fork 声明钉：optionsOf 带 [kind] 标签前缀（上游无），selectionOf 不含标签逻辑', () => {
    // optionsOf 是修改型 fork（新增 ACP 段与 [Model]/[ACP] 前缀）——不做机械比对，
    // 但钉住分叉点的存在性：我们的 optionsOf 引用 PROVIDER_KIND_LABELS，上游不引用。
    expect(POPUP_SRC).toContain('PROVIDER_KIND_LABELS[providerKindOf(group.id)]')
    expect(UPSTREAM_INDEX).not.toContain('PROVIDER_KIND_LABELS')
    // selectionOf 保持 verbatim（不含任何 tag/kind 逻辑）
    const ours = extractFunction(transpile(POPUP_SRC), 'selectionOf')
    expect(ours).not.toContain('PROVIDER_KIND_LABELS')
  })

  it('独立脚本钉：scripts/check-upstream-picker-diff.mjs 对默认 checkout 全绿（exit 0）', () => {
    // 同一组检查的独立入口（发布门禁脱离 vitest 使用）；脚本任一检查漂移/坏掉
    // 会以非零退出在此变红；显式传入与当前套件相同的 checkout。
    const output = execFileSync(
      process.execPath,
      ['scripts/check-upstream-picker-diff.mjs'],
      {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DSH_UPSTREAM_CHECKOUT: upstreamCheckout },
      },
    )
    expect(output).toContain('upstream picker diff: all checks passed')
  })
})
