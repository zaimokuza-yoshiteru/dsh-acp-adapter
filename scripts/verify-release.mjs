#!/usr/bin/env node
/**
 * npm 发布引用门：只允许从与 package.json 版本完全匹配的 Git tag 发布。
 * 所有版本进入 latest；同时给工作流输出唯一 tarball 文件名。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(pkg.version ?? '')
const refType = process.env.GITHUB_REF_TYPE

function exactHeadTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return undefined
  }
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? exactHeadTag()

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version 不是可发布的 SemVer: ${version || '<empty>'}`)
}
if (refType !== undefined && refType !== 'tag') {
  throw new Error(`发布工作流必须从 Git tag 运行，当前 ref type: ${refType}`)
}

const expectedTag = `v${version}`
if (tag !== expectedTag) {
  throw new Error(`发布 tag 必须等于 ${expectedTag}，当前值: ${tag ?? '<missing>'}`)
}

// 预发布版本同样发布到 latest：项目只维护一个用户可见的发布通道。
const distTag = 'latest'
const tarball = `${String(pkg.name).replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
const output = process.env.GITHUB_OUTPUT
if (output) {
  appendFileSync(output, `dist-tag=${distTag}\ntarball=${tarball}\n`)
}

console.log(`[release] ${expectedTag} -> npm ${distTag}; tarball=${tarball}`)
