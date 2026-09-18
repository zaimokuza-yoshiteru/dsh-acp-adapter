#!/usr/bin/env node
// Registry freshness is optional; a complete, valid release input is not.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateSnapshot } from './registry-snapshot.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const root = resolve(scripts, '..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return resolve(process.argv[index + 1])
}
const target = option('--directory', join(root, 'assets/registry'))
const evidence = option('--evidence', join(root, '.local/registry-release'))
const files = ['registry.json', 'executables.json']
const source = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const sourceCommit = process.env.GITHUB_SHA ?? 'local'
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hashes = directory => Object.fromEntries(files.map(name => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]))
const snapshot = directory => {
  const registry = read(join(directory, files[0]))
  const executables = read(join(directory, files[1]))
  validateSnapshot(registry, executables)
  return { registry, executables }
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;').replaceAll('`', '&#96;').replaceAll('\r', '').replaceAll('\n', ' ')

function changes(before, after) {
  const previous = new Map(before.registry.agents.map(agent => [agent.id, agent]))
  const current = new Map(after.registry.agents.map(agent => [agent.id, agent]))
  const launch = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'version'))
  return {
    added: [...current.keys()].filter(id => !previous.has(id)),
    removed: [...previous.keys()].filter(id => !current.has(id)),
    updated: [...current].flatMap(([id, agent]) => {
      const old = previous.get(id)
      if (!old) return []
      const executableChanged = !isDeepStrictEqual(launch(before.executables.entries[id]), launch(after.executables.entries[id]))
      if (isDeepStrictEqual(old, agent) && !executableChanged) return []
      return [{ id, from: old.version, to: agent.version, fields: [...new Set([...Object.keys(old), ...Object.keys(agent)])].filter(key => !isDeepStrictEqual(old[key], agent[key])), executableChanged }]
    }),
  }
}

function summary(report) {
  const delta = report.changes
  return [
    '## ACP Registry', '',
    `Result: **${report.status}**. ${report.status === 'fallback' ? 'Sync failed; using the validated snapshot committed with this release. Deployment continues.' : 'The complete validated snapshot is used for this release.'}`,
    `Agents: ${report.agentCount}. Source commit: ${escape(report.sourceCommit)}.`,
    `Added: ${delta.added.length}; removed: ${delta.removed.length}; updated: ${delta.updated.length}.`, '',
    ...delta.added.map(id => `- Added: ${escape(id)}`),
    ...delta.removed.map(id => `- Removed: ${escape(id)}`),
    ...delta.updated.map(item => `- Updated: ${escape(item.id)} (${escape(item.from)} → ${escape(item.to)}); fields: ${item.fields.map(escape).join(', ') || 'none'}${item.executableChanged ? '; executable defaults changed' : ''}.`),
    ...(report.error ? ['', `Reason: ${escape(report.error)}`] : []),
    '', 'Frozen release inputs (SHA-256):', '',
    ...Object.entries(report.hashes).map(([name, hash]) => `- ${name}: \`${hash}\``),
    '', 'The release-registry-snapshot artifact contains both JSON files and this report. Re-running this workflow reuses that snapshot; a new workflow run may resolve a newer registry.', '',
  ].join('\n')
}

async function download() {
  let failure
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`Registry HTTP ${response.status}`)
      return await response.text()
    } catch (error) { failure = error }
  }
  throw failure
}

// Reject a broken fallback before trying the network. Never hide a repository defect.
const baseline = snapshot(target)
const beforeHashes = hashes(target)
let report
if (process.argv.includes('--reuse') && existsSync(join(evidence, 'report.json'))) {
  report = read(join(evidence, 'report.json'))
  snapshot(evidence)
  if (report.sourceCommit !== sourceCommit || !isDeepStrictEqual(report.baselineHashes, beforeHashes)
    || !isDeepStrictEqual(report.hashes, hashes(evidence)) || !['updated', 'unchanged', 'fallback'].includes(report.status)) {
    throw new Error('Frozen registry input does not match this source commit or its recorded hashes')
  }
} else {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-registry-sync-'))
  let selected = target
  let next = baseline
  let failure
  try {
    writeFileSync(join(stage, files[0]), await download())
    execFileSync(process.execPath, [...process.execArgv, join(scripts, 'enrich-registry-executables.mjs'), '--file', join(stage, files[0]), '--out', join(stage, files[1])], {
      encoding: 'utf8', stdio: 'pipe', timeout: 300_000, maxBuffer: 1024 * 1024,
    })
    next = snapshot(stage)
    selected = stage
  } catch (error) {
    failure = String(error.message ?? error).slice(0, 6000)
  }
  try {
    mkdirSync(evidence, { recursive: true })
    for (const name of files) copyFileSync(join(selected, name), join(evidence, name))
    report = {
      status: failure ? 'fallback' : isDeepStrictEqual(baseline, next) ? 'unchanged' : 'updated',
      source, sourceCommit, checkedAt: new Date().toISOString(), baselineHashes: beforeHashes,
      hashes: hashes(evidence), agentCount: next.registry.agents.length,
      changes: changes(baseline, next), ...(failure ? { error: failure } : {}),
    }
    writeFileSync(join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// Both files are already validated. File-system errors remain fatal, so a partial
// write can never proceed to packing. On sync failure do not touch the old files.
if (report.status !== 'fallback') for (const name of files) copyFileSync(join(evidence, name), join(target, name))
const markdown = summary(report)
writeFileSync(join(evidence, 'summary.md'), markdown)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${report.status}\n`)
if (report.status === 'fallback') console.warn('::warning::ACP Registry sync failed; continuing with the validated committed snapshot. See the release summary and registry issue.')
console.log(`[registry] ${report.status}; ${report.agentCount} agents; evidence: ${evidence}`)
