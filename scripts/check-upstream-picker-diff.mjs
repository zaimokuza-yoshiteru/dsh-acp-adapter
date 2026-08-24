#!/usr/bin/env node
// check-upstream-picker-diff.mjs — 模型选择器兼容壳的独立上游漂移检查。
//
// 用途：发布门禁/升级评估时脱离 vitest 重跑 upstream-picker-diff.spec.ts 的
// 同一组钉版——上游 tag/commit、verbatim fork（rowId/selectionOf/
// INITIAL_DIRECTORY_STATE）机械比对、slot contract 结构钉、修改型 fork 声明钉。
// 检查清单必须与 test/contracts/upstream-picker-diff.spec.ts 保持同步（双侧钉版纪律：
// 该 spec 内含「本脚本 exit 0」用例，脚本坏掉/漂移会在 pnpm test 变红）。
//
// 用法：
//   node scripts/check-upstream-picker-diff.mjs [上游 checkout 路径]
//   DSH_UPSTREAM_CHECKOUT=/path/to/deepseek-harness node scripts/check-upstream-picker-diff.mjs
// 默认依次查找 <repo>/reference/deepseek-harness 与
// <repo>/../reference/deepseek-harness；CI 应显式设置 DSH_UPSTREAM_CHECKOUT。
// 任何漂移：逐条点名并 exit 1（fail loud）。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkoutCandidates = [
  process.argv[2],
  process.env.DSH_UPSTREAM_CHECKOUT,
  path.join(REPO_ROOT, 'reference', 'deepseek-harness'),
  path.join(REPO_ROOT, '..', 'reference', 'deepseek-harness'),
].filter((candidate) => candidate !== undefined && candidate !== '')
const checkout = path.resolve(checkoutCandidates.find((candidate) => fs.existsSync(candidate)) ?? checkoutCandidates[0])

const require = createRequire(path.join(REPO_ROOT, 'package.json'))
const ts = require('typescript')

const UPSTREAM_ROOT = path.join(checkout, 'packages/client/ui-model-selection')
const UPSTREAM_TAG = 'dsh-v0.1.1-rc.2'
const UPSTREAM_COMMIT = 'b150a551b8'

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const readFile = (file) => fs.readFileSync(file, 'utf8')

/** 脱类型：与上游构建产物的差距只剩排版/注释（归一化吸收）。 */
function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  }).outputText
}

function extractBlockAt(text, start) {
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

/** 具名函数体抽取（括号配平；模板串 ${} 自配平）。 */
function extractFunction(text, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text)
  if (match === null) throw new Error(`function not found: ${name}`)
  return extractBlockAt(text, match.index)
}

/** 锚点后首个 `{` 起的对象字面量抽取（两侧锚点文本不同但字面量可比对时用）。 */
function extractObjectLiteral(text, anchor) {
  const match = anchor.exec(text)
  if (match === null) throw new Error(`anchor not found: ${anchor}`)
  return extractBlockAt(text, text.indexOf('{', match.index))
}

/**
 * 排版归一化：去注释；统一引号；对象键去引号（`"key":` → `key:`，吸收 transpile
 * 产物差异）；花括号/分号消解为空白；空白与标点间距压平。只保语义 token 流——
 * 两侧同一算法，漂移必然改变 token 流。
 */
function normalizeJs(text) {
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
function normalizeWs(text) {
  return text.replace(/\s+/g, ' ').trim()
}

console.log(`upstream checkout: ${checkout}`)
assert(fs.existsSync(UPSTREAM_ROOT), `上游 checkout 不存在或不完整：${UPSTREAM_ROOT}`)
assert(fs.existsSync(path.join(checkout, 'packages/client/ui-conversation/src/client/contract/slots.ts')),
  `ui-conversation slot contract 缺席：${checkout}`)

const UPSTREAM_INDEX = readFile(path.join(UPSTREAM_ROOT, 'src/client/index.ts'))
const UPSTREAM_DIRECTORY = readFile(path.join(UPSTREAM_ROOT, 'src/client/directory.ts'))
const UPSTREAM_SLOTS = readFile(path.join(UPSTREAM_ROOT, 'src/client/slots.ts'))
const UI_CONVERSATION_SLOTS = readFile(path.join(checkout, 'packages/client/ui-conversation/src/client/contract/slots.ts'))
// verbatim popup fork 收在 client 侧兼容岛；目录初值钉仍在 data 业务模块。
const POPUP_SRC = readFile(path.join(REPO_ROOT, 'src/client/host-compat/model-picker/popup.ts'))
const SELECTOR_LOGIC_SRC = readFile(path.join(REPO_ROOT, 'src/client/data/selector-logic.ts'))

check('版本钉：上游包 version === 0.1.1-rc.2；tag/commit 常量不被改', () => {
  const manifest = JSON.parse(readFile(path.join(UPSTREAM_ROOT, 'package.json')))
  assert(manifest.name === '@deepseek-ai/dsh-client-ui-model-selection', `上游包名漂移：${manifest.name}`)
  assert(manifest.version === '0.1.1-rc.2', `上游版本漂移：${manifest.version}`)
  assert(UPSTREAM_TAG === 'dsh-v0.1.1-rc.2' && UPSTREAM_COMMIT === 'b150a551b8', 'tag/commit 常量被改')
})

check('verbatim：rowId 函数体与上游 index.ts 机械一致', () => {
  const upstream = normalizeJs(extractFunction(transpile(UPSTREAM_INDEX), 'rowId'))
  const ours = normalizeJs(extractFunction(transpile(POPUP_SRC), 'rowId'))
  assert(ours === upstream, `rowId 漂移\n  upstream: ${upstream}\n  ours:     ${ours}`)
})

check('verbatim：selectionOf 函数体与上游 index.ts 机械一致', () => {
  const upstream = normalizeJs(extractFunction(transpile(UPSTREAM_INDEX), 'selectionOf'))
  const ours = normalizeJs(extractFunction(transpile(POPUP_SRC), 'selectionOf'))
  assert(ours === upstream, `selectionOf 漂移\n  upstream: ${upstream}\n  ours:     ${ours}`)
})

check('verbatim：INITIAL_DIRECTORY_STATE 初值 === 上游 directory.ts createSnapshotStore 初值', () => {
  const upstream = normalizeJs(extractObjectLiteral(UPSTREAM_DIRECTORY, /createSnapshotStore<[\s\S]*?>\(\s*/))
  const ours = normalizeJs(extractObjectLiteral(transpile(SELECTOR_LOGIC_SRC), /INITIAL_DIRECTORY_STATE\s*=\s*/))
  assert(ours === upstream, `INITIAL_DIRECTORY_STATE 漂移\n  upstream: ${upstream}\n  ours:     ${ours}`)
})

check('slot contract：座位声明——conversation.input.model 是 session 作用域 single 座', () => {
  assert(
    normalizeWs(UI_CONVERSATION_SLOTS).includes(
      `'conversation.input.model': { kind: 'single'; scope: 'session'; owner: InputControlOwnerProps }`,
    ),
    'ui-conversation 座位声明漂移（kind/scope/owner 任一变动都需要 review 入口 2）',
  )
})

check('slot contract：注册形态——slots.inject/register 的 name/locale/inject 工厂/组件 ModelSelect', () => {
  assert(UPSTREAM_INDEX.includes(`slots.inject('conversation.input.model'`), '上游缺 slots.inject 目标座位')
  const descriptor = normalizeJs(extractObjectLiteral(transpile(UPSTREAM_INDEX), /slots\.register\(\s*/))
  assert(descriptor.includes('name:"conversation.input.model"'), 'register name 漂移')
  assert(descriptor.includes('locale:NS'), 'register locale 漂移')
  assert(descriptor.includes('inject:(sessionId)'), 'inject 工厂形态漂移')
  assert(descriptor.includes('directory:directory.store'), 'inject 注入面 directory 键漂移')
  assert(descriptor.includes('select:(selection)=>available'), 'inject 注入面 select 键漂移')
  assert(/slots\.register\([\s\S]*,\s*ModelSelect\)/.test(UPSTREAM_INDEX), '注册组件 ModelSelect 漂移')
})

check('slot contract：注入面 ModelSelectInjected 四键类型（上游 slots.ts）', () => {
  const face = normalizeWs(UPSTREAM_SLOTS)
  for (const pin of [
    'available: boolean',
    'directory: SnapshotStore<ModelDirectoryState>',
    'load: () => void',
    'select: (selection: ModelSelection) => Promise<boolean>',
  ]) {
    assert(face.includes(pin), `ModelSelectInjected 键漂移：${pin}`)
  }
})

check('修改型 fork 声明钉：optionsOf 带 [kind] 标签前缀（上游无），selectionOf 不含标签逻辑', () => {
  assert(POPUP_SRC.includes('PROVIDER_KIND_LABELS[providerKindOf(group.id)]'), 'optionsOf 的标签前缀分叉点消失')
  assert(!UPSTREAM_INDEX.includes('PROVIDER_KIND_LABELS'), '上游出现了 PROVIDER_KIND_LABELS（fork 关系需重估）')
  assert(!extractFunction(transpile(POPUP_SRC), 'selectionOf').includes('PROVIDER_KIND_LABELS'),
    'selectionOf 混入标签逻辑（应保持 verbatim）')
})

if (failures.length > 0) {
  console.error(`\n${failures.length} 项漂移（fail loud）：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('上游漂移需要人工 review 后同步兼容岛（src/client/host-compat/model-picker/）与适配器入口（src/client/index.ts）。')
  process.exit(1)
}
console.log('\nupstream picker diff: all checks passed')
