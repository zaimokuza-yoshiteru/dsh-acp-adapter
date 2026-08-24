#!/usr/bin/env node
// gen-typert.mjs — generate the typert host service manifest + remote client
// from the narrowed ACP remote contract (src/remote/service.ts) by driving
// @deepseek-ai/dsh-typert-generator's public WorkspaceTypertGenerator API
// (the package ships no CLI). External-package recipe proven by
// 本机兼容性探针 (README「外部配方」四个硬条件):
//
//   1. Synthetic workspace staging at .typert/ (gitignored):
//      tsconfig.host.json aggregate + packages/<pkg>/ real directories —
//      WorkspaceAnalyzer hard-requires package roots under <root>/packages/.
//   2. @deepseek-ai/dsh-typert-protocol staged AS SOURCE at
//      packages/typert-protocol/ (vendored byte-for-byte at
//      src/host-compat/typert-protocol from reference HEAD b150a551b8 =
//      dsh-v0.1.1-rc.2; the npm artifact does not ship src/), with `paths`
//      mappings in BOTH the aggregate and the package tsconfig — the npm
//      d.ts is not recognized by isTypeMetaSymbol.
//   3. ./typert (+ ./remote) exports/files pre-declared in package.json
//      (validateExport reads the staged copy of the real package.json).
//   4. Payload types exported from the non-root public subpath ./client
//      (publicRemoteType skips '.', './typert', './remote').
//
// Only the transitive relative-import closure of remote/service.ts is staged,
// so the analysis program never pulls dsh-agent/dsh-session d.ts (their
// TypertLookupMap merges break the analyzer) — mirrored by
// test/contracts/architecture.spec.ts, so drift fails tests. Bare imports
// (@agentclientprotocol/sdk, cordis, …) resolve by walking up to this
// package's real node_modules.
//
// src/client/index.ts is NOT staged verbatim: it value-imports the generated
// lib/typert.remote-client.js for `$mount`, which does not exist on a fresh
// checkout (chicken-and-egg). Its only role in the analysis is the
// publicRemoteType home — payload types reachable from the './client'
// subpath — so the staged copy is a synthetic one-liner re-exporting the
// contract. The real file keeps the same `export type *` line, and the main
// typecheck pins consistency: lib/typert.remote-client.d.ts imports the
// payload types from '<package.json name>/client', which tsconfig paths maps to
// ./src/client/index.ts — a missing re-export fails `pnpm typecheck`.
//
// Artifacts land in lib/ (typert.host.{js,d.ts}, typert.remote-client.{js,d.ts}
// (+ remote-client d.ts.map, excluded from the tarball)) and ship via files[].
//
// Usage: node scripts/gen-typert.mjs [--check]
//   --check  fail if lib/ artifacts are missing or stale vs a fresh regen.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator';

const checkMode = process.argv.includes('--check');
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = join(PACKAGE_DIR, 'lib');
const SRC_DIR = join(PACKAGE_DIR, 'src');
const STAGE_DIR = join(PACKAGE_DIR, '.typert');
const VENDOR_FROM = join(PACKAGE_DIR, 'src/host-compat/typert-protocol');

// The generator's `generate(packages)` filter and the emitted manifest.package /
// method-id prefixes all derive from the staged package.json `name` — read the
// real manifest once so a rename (: @zaimokuza/ scope) never drifts. The
// staging DIRECTORY below keeps the neutral name dsh-acp-adapter: package roots
// only need to live under <root>/packages/, the dirname is not the identity.
const REAL_PKG = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
const PACKAGE_NAME = REAL_PKG.name;

// Entry point whose relative-import closure is staged for analysis.
const ENTRY_POINTS = ['remote/service.ts'];

const IMPORT_FROM_RE = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Transitive relative-import closure of `entries` under src/, matching the
 * import regexes in test/contracts/architecture.spec.ts. Escape-hatch imports that
 * leave src/ (../../lib/… in client/index.ts) and unresolved extensions
 * (./x.module.css, covered by the ambient d.ts) are skipped.
 */
function relativeImportClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(SRC_DIR, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const re of [IMPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      for (let match = re.exec(text); match !== null; match = re.exec(text)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        let target = join(dirname(rel), spec);
        if (target.startsWith('..')) continue; // escapes src/ — not staged
        if (!/\.[cm]?[tj]s$/.test(target)) target += '.ts';
        if (!seen.has(target)) queue.push(target);
      }
    }
  }
  return [...seen].filter((rel) => existsSync(join(SRC_DIR, rel)));
}

/** Shared compilerOptions, mirroring the spike workspace tsconfigs. */
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
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function stage() {
  rmSync(STAGE_DIR, { recursive: true, force: true });

  // packages/typert-protocol — vendored source (spike recipe #2).
  const protocolRoot = join(STAGE_DIR, 'packages', 'typert-protocol');
  mkdirSync(join(protocolRoot, 'src'), { recursive: true });
  for (const f of ['index.ts', 'types.ts']) {
    cpSync(join(VENDOR_FROM, f), join(protocolRoot, 'src', f));
  }
  writeJson(join(protocolRoot, 'package.json'), {
    name: '@deepseek-ai/dsh-typert-protocol',
    version: '0.1.1-rc.2',
    private: true,
    type: 'module',
  });
  writeJson(join(protocolRoot, 'tsconfig.json'), {
    compilerOptions: {
      ...TS_COMPILER_OPTIONS,
      composite: true,
      declaration: true,
      rootDir: 'src',
      outDir: 'lib/types',
      // Analysis only — allow this package's `.ts`-suffixed import specifiers.
      allowImportingTsExtensions: true,
      emitDeclarationOnly: true,
    },
    include: ['src'],
  });

  // packages/dsh-acp-adapter — package.json with NARROWED exports: the real
  // `.` entry resolves to src/index.ts, which is intentionally outside the
  // staged closure (it would pull the whole host face, incl. the dsh-agent
  // chain, into the analyzer). FaceAnalyzer.collectExports resolves every
  // declared subpath to a staged source file, so the staged copy keeps only
  // `./client` (src/client/index.ts — the publicRemoteType home), `./typert`,
  // `./remote` (both skipped by the analyzer), and `./package.json`.
  // validateExport still sees the ./typert + ./remote declarations (recipe #3)
  // and the real files[] list.
  //
  // Plus one staging-only subpath: `./service` → src/remote/service.ts. The
  // analyzer discovers a host face by walking package-internal imports from
  // its export entry sources until it finds a surface (a class member with a
  // `@Remote` decorator); `./client` never reaches host code (layering), and
  // `./typert`/`./remote` are excluded from entrySourcePaths, so without this
  // pseudo-entry the face is never discovered. The emitted descriptors bind
  // the service by NAME (`ctx.get('dshAcp')`), so the extra subpath has no
  // effect on the artifacts or the real package manifest.
  const staged = join(STAGE_DIR, 'packages', 'dsh-acp-adapter');
  mkdirSync(staged, { recursive: true });
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
  });
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
        '@deepseek-ai/dsh-typert-protocol': ['../typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['../typert-protocol/src/types.ts'],
      },
    },
    include: ['src'],
  });
  for (const rel of relativeImportClosure(ENTRY_POINTS)) {
    const dest = join(staged, 'src', rel.split('/').join(sep));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(SRC_DIR, rel), dest);
  }
  // Synthetic './client' entry: the publicRemoteType home (recipe #4). Mirrors
  // the `export type *` line of the real src/client/index.ts (see header).
  mkdirSync(join(staged, 'src', 'client'), { recursive: true });
  writeFileSync(
    join(staged, 'src', 'client', 'index.ts'),
    "export type * from '../contract/remote.ts'\n",
  );

  // Aggregate face tsconfig (spike recipe #1).
  writeJson(join(STAGE_DIR, 'tsconfig.host.json'), {
    compilerOptions: {
      ...TS_COMPILER_OPTIONS,
      composite: false,
      noEmit: true,
      allowImportingTsExtensions: true,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'],
        '@deepseek-ai/dsh-typert-protocol/types': ['packages/typert-protocol/src/types.ts'],
      },
    },
    files: [],
    references: [{ path: 'packages/dsh-acp-adapter' }, { path: 'packages/typert-protocol' }],
  });
}

function main() {
  stage();

  const generator = new WorkspaceTypertGenerator(STAGE_DIR);
  const artifacts = generator.generate([PACKAGE_NAME], ['host']);
  const artifact = artifacts.find((a) => a.package === PACKAGE_NAME && a.face === 'host');
  if (artifact === undefined || artifact.remote === undefined) {
    throw new Error(
      `typert generation produced no host+remote artifact for ${PACKAGE_NAME} (got: ${JSON.stringify(
        artifacts.map((a) => ({ package: a.package, face: a.face, remote: a.remote !== undefined })),
      )})`,
    );
  }

  const emitted = {
    'typert.host.js': artifact.js,
    'typert.host.d.ts': artifact.dts,
    'typert.remote-client.js': artifact.remote.js,
    'typert.remote-client.d.ts': artifact.remote.dts,
    'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
  };

  if (checkMode) {
    for (const [name, content] of Object.entries(emitted)) {
      const shipped = join(LIB_DIR, name);
      if (!existsSync(shipped) || readFileSync(shipped, 'utf8') !== content) {
        throw new Error(
          `lib/${name} is missing or stale — run \`node scripts/gen-typert.mjs\` and rebuild.`,
        );
      }
    }
    console.log('gen-typert: lib/ typert artifacts are up to date.');
    return;
  }

  mkdirSync(LIB_DIR, { recursive: true });
  for (const [name, content] of Object.entries(emitted)) {
    writeFileSync(join(LIB_DIR, name), content);
  }
  console.log(`gen-typert: wrote ${Object.keys(emitted).length} artifacts to lib/`);
}

main();
