#!/usr/bin/env node
// Generate the Host manifest and Remote client from src/remote/service.ts
// through the published WorkspaceTypertGenerator API.
//
// The analyzer requires a workspace with packages/ roots. .typert/ stages
// only the service's relative-import closure, avoiding Host-wide
// TypertLookupMap merges. Bare imports resolve from this package's node_modules.
// Staging the exact published protocol declarations gives Typert symbols one
// analysis-program identity without maintaining a second protocol definition.
//
// The staged ./client entry exports payload types without importing generated
// runtime files. Its export matches src/client/index.ts; the generated public
// declarations and main typecheck verify that match. Manifest validation uses
// the real ./typert, ./remote and files[] declarations.
//
// Artifacts are written to lib/typert.host.{js,d.ts} and
// lib/typert.remote-client.{js,d.ts,d.ts.map}; the map is not published.
//
// Usage: node scripts/gen-typert.ts [--check]
//   --check  fail if lib/ artifacts are missing or stale vs a fresh regen.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSnapshot } from './registry-snapshot.ts'
import { DSH_SOURCE_VERSION } from './dsh-target.ts'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const checkMode = process.argv.includes('--check')
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
validateSnapshot(
  JSON.parse(readFileSync(join(PACKAGE_DIR, 'assets/registry/registry.json'), 'utf8')),
  JSON.parse(readFileSync(join(PACKAGE_DIR, 'assets/registry/executables.json'), 'utf8')),
)
const LIB_DIR = join(PACKAGE_DIR, 'lib')
const SRC_DIR = join(PACKAGE_DIR, 'src')
const STAGE_DIR = join(PACKAGE_DIR, '.typert')
const PROTOCOL_MANIFEST = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))

// Package identity and method IDs use the manifest name, not the staging directory.
const REAL_PKG = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const PACKAGE_NAME = REAL_PKG.name

// Entry point whose relative-import closure is staged for analysis.
const ENTRY_POINTS = ['remote/service.ts']

const IMPORT_FROM_RE = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Transitive relative-import closure of `entries` under src/, matching the
 * import regexes in test/contracts/architecture.spec.ts. Escape-hatch imports
 * that leave src/ (../../lib/… in client/index.ts) and unresolved extensions
 * (./x.module.css, covered by the ambient d.ts) are skipped — except JSON
 * data imports (assets/registry snapshots), which resolve outside src/ but
 * inside the package and must be staged alongside their importer (collected
 * in `dataImports`).
 */
function relativeImportClosure(entries: readonly string[]) {
  const seen = new Set<string>()
  const dataImports = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const rel = queue.pop()!
    if (seen.has(rel)) continue
    seen.add(rel)
    const abs = join(SRC_DIR, rel)
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, 'utf8')
    for (const re of [IMPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0
      for (let match = re.exec(text); match !== null; match = re.exec(text)) {
        const spec = match[1]
        if (!spec.startsWith('.')) continue
        let target = join(dirname(rel), spec)
        if (target.startsWith('..')) {
          if (target.endsWith('.json')) dataImports.add(join('src', target))
          continue
        }
        if (!/\.[cm]?[tj]s$/.test(target)) target += '.ts'
        if (!seen.has(target)) queue.push(target)
      }
    }
  }
  return { sources: [...seen].filter((rel) => existsSync(join(SRC_DIR, rel))), dataImports: [...dataImports] }
}

/** Compiler options shared by the staged package and aggregate analysis. */
const TS_COMPILER_OPTIONS = {
  target: 'ES2024',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  skipLibCheck: true,
  types: [],
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function stage() {
  rmSync(STAGE_DIR, { recursive: true, force: true })

  // Bind all analyzer references to the same protocol declarations.
  const protocolRoot = join(STAGE_DIR, 'packages', 'typert-protocol')
  const protocolPackage = JSON.parse(readFileSync(PROTOCOL_MANIFEST, 'utf8'))
  const protocolTypes = resolve(dirname(PROTOCOL_MANIFEST), protocolPackage.types)
  cpSync(dirname(protocolTypes), join(protocolRoot, 'src'), { recursive: true })
  writeJson(join(protocolRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-typert-protocol',
    version: DSH_SOURCE_VERSION,
    private: true,
    type: 'module',
  })
  writeJson(join(protocolRoot, 'tsconfig.json'), {
    compilerOptions: {
      ...TS_COMPILER_OPTIONS,
      composite: true,
      declaration: true,
      outDir: 'lib/types',
      emitDeclarationOnly: true,
    },
    include: ['src'],
  })

  // Exclude the root Host export from analysis. The staging-only ./service
  // export makes the decorated Remote service discoverable; ./client cannot
  // reach Host code and the analyzer skips ./typert and ./remote entry sources.
  // Generated descriptors bind ctx.get('dshAcp'), so ./service is not published.
  const staged = join(STAGE_DIR, 'packages', 'dsh-acp-adapter')
  mkdirSync(staged, { recursive: true })
  writeJson(join(staged, 'package.json'), {
    ...REAL_PKG,
    exports: {
      './client': REAL_PKG.exports['./client'],
      './service': {
        types: './lib/types/remote/service.d.ts',
        default: './lib/remote/service.js',
      },
      './typert': REAL_PKG.exports['./typert'],
      './remote': REAL_PKG.exports['./remote'],
      './package.json': './package.json',
    },
  })
  writeJson(join(staged, 'tsconfig.json'), {
    compilerOptions: {
      ...TS_COMPILER_OPTIONS,
      composite: true,
      declaration: true,
      rootDir: 'src',
      outDir: 'lib/types',
      allowImportingTsExtensions: true,
      emitDeclarationOnly: true,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['../typert-protocol/src/index.d.ts'],
      },
    },
    include: ['src'],
  })
  const { sources, dataImports } = relativeImportClosure(ENTRY_POINTS)
  for (const rel of sources) {
    const dest = join(staged, 'src', rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(SRC_DIR, rel), dest)
  }
  // Package-relative JSON data imports (assets/registry snapshots): staged at
  // the same package-relative path so the analyzer's module resolution finds
  // them exactly where the importer expects.
  for (const rel of dataImports) {
    const source = resolve(PACKAGE_DIR, rel)
    if (!existsSync(source)) continue
    const dest = join(staged, rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(source, dest)
  }
  // Public payload type home, matching the real client's type re-export.
  mkdirSync(join(staged, 'src', 'client'), { recursive: true })
  writeFileSync(join(staged, 'src', 'client', 'index.ts'), "export type * from '../contract/remote.ts'\n")

  writeJson(join(STAGE_DIR, 'tsconfig.host.json'), {
    compilerOptions: {
      ...TS_COMPILER_OPTIONS,
      composite: false,
      noEmit: true,
      allowImportingTsExtensions: true,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.d.ts'],
      },
    },
    files: [],
    references: [{ path: 'packages/dsh-acp-adapter' }, { path: 'packages/typert-protocol' }],
  })
}

function main() {
  stage()

  const generator = new WorkspaceTypertGenerator(STAGE_DIR)
  const artifacts = generator.generate([PACKAGE_NAME], ['host'])
  const artifact = artifacts.find((a) => a.package === PACKAGE_NAME && a.face === 'host')
  if (artifact === undefined || artifact.remote === undefined) {
    throw new Error(
      `typert generation produced no host+remote artifact for ${PACKAGE_NAME} (got: ${JSON.stringify(
        artifacts.map((a) => ({ package: a.package, face: a.face, remote: a.remote !== undefined })),
      )})`,
    )
  }

  const emitted = {
    'typert.host.js': artifact.js,
    'typert.host.d.ts': artifact.dts,
    'typert.remote-client.js': artifact.remote.js,
    'typert.remote-client.d.ts': artifact.remote.dts,
    'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
  }

  if (checkMode) {
    for (const [name, content] of Object.entries(emitted)) {
      const shipped = join(LIB_DIR, name)
      if (!existsSync(shipped) || readFileSync(shipped, 'utf8') !== content) {
        throw new Error(`lib/${name} is missing or stale — run \`node scripts/gen-typert.ts\` and rebuild.`)
      }
    }
    console.log('gen-typert: lib/ typert artifacts are up to date.')
    return
  }

  mkdirSync(LIB_DIR, { recursive: true })
  for (const [name, content] of Object.entries(emitted)) {
    writeFileSync(join(LIB_DIR, name), content)
  }
  console.log(`gen-typert: wrote ${Object.keys(emitted).length} artifacts to lib/`)
}

main()
