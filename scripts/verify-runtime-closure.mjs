import { dirname, join, normalize } from 'node:path'

/**
 * Find relative JavaScript imports whose resolved runtime module is absent
 * from a package file set. The callback is deliberately separate from the
 * file list so callers can compare disk source with the npm tarball manifest.
 *
 * This checks emitted host/runtime artifacts as well as generated entry
 * points. Type-only imports are already gone from emitted JavaScript; only
 * runtime ESM, dynamic import, and require forms are considered.
 */
export function findMissingRelativeRuntimeImports(files, readFile) {
  const actual = new Set(files.map(normalizeFile))
  const failures = []
  for (const file of actual) {
    if (!file.endsWith('.js')) continue
    let source
    try {
      source = readFile(file)
    } catch {
      failures.push({ file, specifier: '<file-unreadable>', resolved: file })
      continue
    }
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = resolveRuntimeImport(file, specifier)
      if (resolved === undefined || !runtimeCandidates(resolved).some(candidate => actual.has(candidate))) {
        failures.push({ file, specifier, resolved: resolved ?? '<outside-package>' })
      }
    }
  }
  return failures
}

function normalizeFile(file) {
  return String(file).replaceAll('\\', '/').replace(/^\.\//, '')
}

function relativeSpecifiers(source) {
  const result = new Set()
  const patterns = [
    /\b(?:import|export)\s+[^'"`]*?\sfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.add(match[1])
  }
  return result
}

function resolveRuntimeImport(file, specifier) {
  const base = normalize(join(dirname(file), specifier)).replaceAll('\\', '/')
  if (base === '..' || base.startsWith('../')) return undefined
  return base
}

function runtimeCandidates(resolved) {
  if (/\.[cm]?js$/.test(resolved) || resolved.endsWith('.json')) return [resolved]
  return [resolved, `${resolved}.js`, `${resolved}/index.js`]
}
