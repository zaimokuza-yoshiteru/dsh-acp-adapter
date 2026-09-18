#!/usr/bin/env node
// enrich-registry-executables.ts
// 
// Resolution order per agent (distribution kind):
//   binary → explicit manual configuration (Agent host platform is unknown)
//   npx    → the selected npm package version → bin
//   uvx    → PyPI JSON API → sdist pyproject.toml [project.scripts]

import { selectedDistribution, launchDefaults, binaryEntry, validateSnapshot } from "./registry-snapshot.ts";
import type { RegistryAgent, RegistrySnapshot, ExecutableEntry } from './registry-snapshot.ts';
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const registryFile =
  fileIndex >= 0
    ? resolve(args[fileIndex + 1])
    : resolve("assets/registry/registry.json");
const outIndex = args.indexOf("--out");
const outFile =
  outIndex >= 0
    ? resolve(args[outIndex + 1])
    : resolve("assets/registry/executables.json");

const NPM_DELAY_MS = 150;

const registry: RegistrySnapshot = JSON.parse(readFileSync(registryFile, "utf8"));
const agents = Array.isArray(registry?.agents) ? registry.agents : [];

/** npm bin paths are "name": "path/to/file.js"; the PATH executable is the KEY. */
function binCommandOf(bins: unknown, packageName: string) {
  if (typeof bins === "string" && bins) return packageName.slice(packageName.lastIndexOf("/") + 1);
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) return null;
  const keys = Object.keys(bins);
  if (keys.includes(packageName)) return packageName;
  const lastSegment = packageName.slice(packageName.lastIndexOf("/") + 1);
  if (keys.includes(lastSegment)) return lastSegment;
  if (keys.length === 1) return keys[0];
  const primary = keys.filter((key) => !/-tools$/.test(key));
  return primary.length === 1 ? primary[0] : null;
}

function stripVersion(packageSpec: string) {
  const atIndex = packageSpec.lastIndexOf("@");
  if (atIndex <= 0) return packageSpec;
  return packageSpec.slice(0, atIndex);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

async function resolveNpx(agent: RegistryAgent) {
  const spec = agent.distribution?.npx?.package;
  if (typeof spec !== "string" || spec === "") return null;
  const packageName = stripVersion(spec);
  const encoded = packageName.startsWith("@")
    ? packageName.replace("/", "%2F")
    : encodeURIComponent(packageName);
  const manifest = await fetchJson<{ 'dist-tags'?: Record<string, string>; versions?: Record<string, { bin?: unknown }> }>(`https://registry.npmjs.org/${encoded}`);
  const requested = spec === packageName ? "latest" : spec.slice(packageName.length + 1);
  const version = manifest?.["dist-tags"]?.[requested] ?? requested;
  const versionManifest = manifest?.versions?.[version];
  const command = binCommandOf(versionManifest?.bin, packageName);
  if (!command) return null;
  return { command, ...launchDefaults(agent.distribution.npx!) };
}

function scriptsEntryOf(toml: string, projectName: string) {
  const match = toml.match(
    /^\s*\[project\.scripts\][ \t]*\n((?:[^\n]|\n(?!\[))*)/m,
  );
  if (!match) return null;
  const lines = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const names = lines.map(line => line.match(/^([\w.-]+)\s*=\s*["']/)?.[1]).filter(Boolean);
  if (names.includes(projectName)) return projectName;
  return names.length === 1 ? names[0] : null;
}

async function resolveUvx(agent: RegistryAgent) {
  const spec = agent.distribution?.uvx?.package;
  if (typeof spec !== "string" || spec === "") return null;
  const projectName = spec.split(/[=<>!~@]/)[0];
  const versionMatch = spec.match(/(?:==|@)([^=<>!~@]+)$/);
  if (spec !== projectName && !versionMatch) throw new Error(`unsupported Python package spec: ${spec}`);
  const meta = versionMatch
    ? await fetchJson<{ urls?: { packagetype: string; url: string }[] }>(
        `https://pypi.org/pypi/${projectName}/${versionMatch[1]}/json`,
      )
    : await fetchJson<{ urls?: { packagetype: string; url: string }[] }>(`https://pypi.org/pypi/${projectName}/json`);
  const sdist = (meta?.urls ?? []).find((url) => url.packagetype === "sdist");
  if (!sdist?.url) return null;
  const archive = await fetch(sdist.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!archive.ok) throw new Error(`HTTP ${archive.status} for ${sdist.url}`);
  const tar = await archive.arrayBuffer();
  const { spawnSync } = await import("node:child_process");
  const {
    mkdtempSync,
    rmSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "enrich-uvx-"));
  try {
    const tarPath = join(dir, "sdist.tar.gz");
    writeFileSync(tarPath, Buffer.from(tar));
    // Read only the root pyproject from the archive; never extract package files.
    const listing = spawnSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error("could not list sdist archive");
    const candidates = listing.stdout.split("\n").filter(name => /^[^/]+\/pyproject\.toml$/.test(name));
    if (candidates.length !== 1) throw new Error("expected one root pyproject.toml");
    const result = spawnSync("tar", ["-xOf", tarPath, candidates[0]], { encoding: "utf8" });
    if (result.status !== 0) throw new Error("could not read pyproject.toml");
    const command = scriptsEntryOf(result.stdout, projectName);
    if (command) return { command, ...launchDefaults(agent.distribution.uvx!) };
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entries: Record<string, ExecutableEntry> = {};
for (const agent of agents) {
  const { kind } = selectedDistribution(agent);
  const executable = kind === "binary" ? binaryEntry(agent)
    : kind === "npx" ? await resolveNpx(agent) : await resolveUvx(agent);
  if (!executable) throw new Error(`${agent.id}: no unambiguous executable resolved`);
  entries[agent.id] = { version: agent.version, kind, ...executable };
  if (kind !== "binary") await sleep(NPM_DELAY_MS);
}
// Validate the complete result before replacing the sidecar. Any failure leaves it intact.
const sidecar = { entries };
validateSnapshot(registry, sidecar);
writeFileSync(outFile, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
console.log(`enrich-registry-executables: OK (${agents.length} entries → ${outFile})`);
