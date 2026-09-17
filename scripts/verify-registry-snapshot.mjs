#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateSnapshot } from './registry-snapshot.mjs';

const index = process.argv.indexOf('--file');
const target = resolve(index < 0 ? 'assets/registry/registry.json' : process.argv[index + 1]);
try {
  const registry = JSON.parse(readFileSync(target, 'utf8'));
  const sidecar = JSON.parse(readFileSync(resolve(dirname(target), 'executables.json'), 'utf8'));
  validateSnapshot(registry, sidecar);
  console.log(`verify-registry-snapshot: OK (${registry.agents.length} agents)`);
} catch (error) {
  console.error(`verify-registry-snapshot: ${error.message}`);
  process.exitCode = 1;
}
