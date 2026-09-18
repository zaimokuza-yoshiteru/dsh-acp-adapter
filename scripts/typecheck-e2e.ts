#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.env.DSH_UPSTREAM_CHECKOUT ?? resolve(root, '../reference/deepseek-harness')
const requireHost = createRequire(join(host, 'apps/web/package.json'))
const output = join(root, '.local/e2e-types')
mkdirSync(output, { recursive: true })

// Derive the test API from the selected host, rather than hand-maintaining a
// second scaffold contract or typechecking upstream host and client in one program.
for (const name of ['scaffold', 'support']) {
  const source = join(host, `apps/web/tests/${name}.ts`)
  const result = ts.transpileDeclaration(readFileSync(source, 'utf8'), {
    fileName: source,
    compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  })
  writeFileSync(join(output, `${name}.d.ts`), result.outputText)
}
const config = {
  extends: join(root, 'tsconfig.tools.json'),
  compilerOptions: {
    lib: ['ES2024', 'DOM', 'DOM.Iterable'],
    erasableSyntaxOnly: false,
    paths: {
      '#host-scaffold': [join(output, 'scaffold.d.ts')],
      '#host-support': [join(output, 'support.d.ts')],
      playwright: [join(dirname(requireHost.resolve('playwright/package.json')), 'index.d.ts')],
    },
  },
  include: [join(root, 'test/e2e/**/*.ts'), join(root, 'src/**/*.ts')],
  exclude: [],
}
const path = join(output, 'tsconfig.json')
writeFileSync(path, JSON.stringify(config, null, 2))
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', path, '--pretty', 'false'], { cwd: root, stdio: 'inherit' })
