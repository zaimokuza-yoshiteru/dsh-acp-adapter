#!/usr/bin/env node
// verify-registry-snapshot.mjs — decode smoke check for the committed ACP
// registry snapshot (assets/registry/registry.json).
//
// Usage: node scripts/verify-registry-snapshot.mjs [--file <path>]

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const target =
  fileIndex >= 0
    ? resolve(args[fileIndex + 1])
    : resolve("assets/registry/registry.json");

const failures = [];

function fail(message) {
  failures.push(message);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(target, "utf8"));
} catch (error) {
  console.error(
    `verify-registry-snapshot: ${target} is not valid JSON: ${error.message}`,
  );
  process.exit(1);
}

if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  console.error("verify-registry-snapshot: top level must be an object");
  process.exit(1);
}
if (typeof parsed.version !== "string" || parsed.version === "") {
  fail('top-level "version" must be a non-empty string');
}
if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
  fail('"agents" must be a non-empty array');
} else {
  for (const [index, agent] of parsed.agents.entries()) {
    const label = `agents[${index}]`;
    if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
      fail(`${label} must be an object`);
      continue;
    }
    for (const field of ["id", "name", "version", "description"]) {
      if (typeof agent[field] !== "string" || agent[field] === "") {
        fail(`${label}.${field} must be a non-empty string`);
      }
    }
    if (agent.distribution !== undefined) {
      if (
        typeof agent.distribution !== "object" ||
        agent.distribution === null ||
        Array.isArray(agent.distribution)
      ) {
        fail(`${label}.distribution must be an object when present`);
      } else if (
        agent.distribution.npx === undefined &&
        agent.distribution.uvx === undefined &&
        agent.distribution.binary === undefined
      ) {
        fail(`${label}.distribution has none of npx/uvx/binary channels`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `verify-registry-snapshot: ${failures.length} violation(s) in ${target}:`,
  );
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

// Executables sidecar checks (assets/registry/executables.json): entries must
// be a subset of registry agent ids, each with a non-empty command, string
// array args, and a version exactly matching the registry entry's version.
const sidecarPath = resolve(dirname(target), "executables.json");
let sidecarParsed;
try {
  sidecarParsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
} catch {
  sidecarParsed = undefined;
}
if (sidecarParsed !== undefined) {
  const sidecarFailures = [];
  if (
    typeof sidecarParsed !== "object" ||
    sidecarParsed === null ||
    Array.isArray(sidecarParsed)
  ) {
    sidecarFailures.push("executables.json top level must be an object");
  } else if (
    typeof sidecarParsed.entries !== "object" ||
    sidecarParsed.entries === null ||
    Array.isArray(sidecarParsed.entries)
  ) {
    sidecarFailures.push('executables.json "entries" must be an object');
  } else {
    const registryById = new Map(
      parsed.agents.map((agent) => [agent.id, agent]),
    );
    for (const [id, entry] of Object.entries(sidecarParsed.entries)) {
      const label = `entries["${id}"]`;
      const registryAgent = registryById.get(id);
      if (registryAgent === undefined) {
        sidecarFailures.push(`${label} is not a registry agent id`);
        continue;
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        sidecarFailures.push(`${label} must be an object`);
        continue;
      }
      if (typeof entry.command !== "string" || entry.command === "") {
        sidecarFailures.push(`${label}.command must be a non-empty string`);
      }
      if (
        !Array.isArray(entry.args) ||
        entry.args.some((arg) => typeof arg !== "string")
      ) {
        sidecarFailures.push(`${label}.args must be an array of strings`);
      }
      if (entry.version !== registryAgent.version) {
        sidecarFailures.push(
          `${label}.version (${JSON.stringify(entry.version)}) does not match registry version (${JSON.stringify(registryAgent.version)})`,
        );
      }
    }
  }
  if (sidecarFailures.length > 0) {
    console.error(
      `verify-registry-snapshot: ${sidecarFailures.length} violation(s) in ${sidecarPath}:`,
    );
    for (const message of sidecarFailures) console.error(`  - ${message}`);
    process.exit(1);
  }
}

console.log(
  `verify-registry-snapshot: OK (${parsed.agents.length} agents, registry schema ${parsed.version})`,
);
