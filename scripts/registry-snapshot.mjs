// Shared, offline rules for the selected distribution and its PATH prefill.
import { isDeepStrictEqual } from 'node:util';

export function selectedDistribution(agent) {
  const d = agent.distribution;
  for (const kind of ['binary', 'npx', 'uvx']) {
    if (d?.[kind] !== undefined) return { kind, value: d[kind] };
  }
  throw new Error(`${agent.id}: no supported distribution`);
}

export function launchDefaults(distribution) {
  const args = distribution.args === undefined ? [] : distribution.args;
  const env = distribution.env === undefined ? {} : distribution.env;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args must be strings');
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) throw new Error('env must contain single-line string values and valid keys');
  return { args, env };
}

export function binaryEntry(agent) {
  const platforms = Object.values(agent.distribution.binary);
  if (!platforms.length || platforms.some(p => !p || typeof p.cmd !== 'string' || !p.cmd.trim() || typeof p.archive !== 'string' || !/^https:\/\//.test(p.archive))) throw new Error(`${agent.id}: invalid binary distribution`);
  const defaults = platforms.map(launchDefaults);
  return {
    kind: 'binary', manualReason: 'host-platform-required', command: '',
    // Common flags are safe to seed even when the executable needs manual selection.
    args: defaults.every(d => isDeepStrictEqual(d.args, defaults[0].args)) ? defaults[0].args : [],
    env: defaults.every(d => isDeepStrictEqual(d.env, defaults[0].env)) ? defaults[0].env : {},
  };
}

export function validateSnapshot(registry, sidecar) {
  if (!registry || typeof registry.version !== 'string' || !registry.version || !Array.isArray(registry.agents) || !registry.agents.length) throw new Error('invalid registry header/agents');
  if (!sidecar?.entries || typeof sidecar.entries !== 'object' || Array.isArray(sidecar.entries)) throw new Error('executables.entries must be an object');
  const ids = new Set();
  for (const agent of registry.agents) {
    for (const key of ['id', 'name', 'version', 'description']) if (typeof agent?.[key] !== 'string' || !agent[key]) throw new Error(`invalid agent ${key}`);
    if (!/^[a-z][a-z0-9-]*$/.test(agent.id) || ids.has(agent.id)) throw new Error(`invalid/duplicate id: ${agent.id}`);
    ids.add(agent.id);
    const entry = sidecar.entries[agent.id];
    if (!entry || entry.version !== agent.version) throw new Error(`${agent.id}: missing executable or version mismatch`);
    const { kind, value } = selectedDistribution(agent);
    if (entry.kind !== kind) throw new Error(`${agent.id}: distribution mismatch`);
    const expected = kind === 'binary' ? binaryEntry(agent) : launchDefaults(value);
    if (!isDeepStrictEqual(entry.args, expected.args) || !isDeepStrictEqual(entry.env, expected.env)) throw new Error(`${agent.id}: args/env differ from selected distribution`);
    if (kind === 'binary') {
      if (entry.command !== '' || entry.manualReason !== expected.manualReason) throw new Error(`${agent.id}: binary requires host platform/manual configuration`);
    } else {
      if (typeof value.package !== 'string' || !value.package || typeof entry.command !== 'string' || !entry.command || /[\s|&;<>()$`"'\\/]/.test(entry.command) || entry.manualReason !== undefined) throw new Error(`${agent.id}: invalid package/executable`);
    }
  }
  for (const id of Object.keys(sidecar.entries)) if (!ids.has(id)) throw new Error(`unknown executable id: ${id}`);
}
