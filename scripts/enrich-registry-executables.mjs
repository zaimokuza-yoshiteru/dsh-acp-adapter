#!/usr/bin/env node
// enrich-registry-executables.mjs
// 
// Resolution order per agent (distribution kind):
//   binary → cmd basename (strip leading ./ and any directory part) + args
//   npx    → npm registry dist-tags.latest → versions[latest].bin
//   uvx    → PyPI JSON API → sdist pyproject.toml [project.scripts]

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

const registry = JSON.parse(readFileSync(registryFile, "utf8"));
const agents = Array.isArray(registry?.agents) ? registry.agents : [];

function warn(message) {
  console.error(`enrich-registry-executables: ${message}`);
}

function basenameOf(cmd) {
  const normalized = cmd.replace(/\\/g, "/");
  const last = normalized.slice(normalized.lastIndexOf("/") + 1);
  return last.trim();
}

/** npm bin paths are "name": "path/to/file.js"; the PATH executable is the KEY. */
function binCommandOf(bins, packageName) {
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) return null;
  const keys = Object.keys(bins);
  if (keys.includes(packageName)) return packageName;
  const lastSegment = packageName.slice(packageName.lastIndexOf("/") + 1);
  if (keys.includes(lastSegment)) return lastSegment;
  if (keys.length === 1) return keys[0];
  const primary = keys.filter((key) => !/-tools$/.test(key));
  return primary.length === 1 ? primary[0] : null;
}

function resolveBinary(agent) {
  const platforms = agent.distribution?.binary ?? {};
  const platform =
    platforms["darwin-aarch64"] ??
    Object.values(platforms).find((entry) => entry?.cmd);
  if (!platform?.cmd) return null;
  const command = basenameOf(platform.cmd);
  if (command === "") return null;
  return {
    command,
    args: Array.isArray(platform.args)
      ? platform.args.filter((arg) => typeof arg === "string")
      : [],
  };
}

function stripVersion(packageSpec) {
  const atIndex = packageSpec.lastIndexOf("@");
  if (atIndex <= 0) return packageSpec;
  return packageSpec.slice(0, atIndex);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

async function resolveNpx(agent) {
  const spec = agent.distribution?.npx?.package;
  if (typeof spec !== "string" || spec === "") return null;
  const packageName = stripVersion(spec);
  const encoded = packageName.startsWith("@")
    ? packageName.replace("/", "%2F")
    : encodeURIComponent(packageName);
  const manifest = await fetchJson(`https://registry.npmjs.org/${encoded}`);
  const latest = manifest?.["dist-tags"]?.latest;
  const versionManifest = latest ? manifest?.versions?.[latest] : undefined;
  const command = binCommandOf(versionManifest?.bin, packageName);
  if (!command) return null;
  const args = Array.isArray(agent.distribution.npx.args)
    ? agent.distribution.npx.args.filter((arg) => typeof arg === "string")
    : [];
  return { command, args };
}

function scriptsEntryOf(toml, projectName) {
  const match = toml.match(
    /^\s*\[project\.scripts\][ \t]*\n((?:[^\n]|\n(?!\[))*)/m,
  );
  if (!match) return null;
  const lines = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const exact = lines.find((line) =>
    line.match(new RegExp(`^${projectName}\\s*=\\s*"`)),
  );
  if (exact) return projectName;
  const entry = lines.find((line) => /^([\w.-]+)\s*=\s*"/.test(line));
  return entry ? entry.match(/^([\w.-]+)\s*=\s*"/)[1] : null;
}

async function resolveUvx(agent) {
  const spec = agent.distribution?.uvx?.package;
  if (typeof spec !== "string" || spec === "") return null;
  const projectName = spec.split(/[=<>!~@]/)[0];
  const versionMatch = spec.match(/(?:[=<>!~]+|@)([^=<>!~@]+)$/);
  const meta = versionMatch
    ? await fetchJson(
        `https://pypi.org/pypi/${projectName}/${versionMatch[1]}/json`,
      )
    : await fetchJson(`https://pypi.org/pypi/${projectName}/json`);
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
    readFileSync: readTmp,
    rmSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "enrich-uvx-"));
  try {
    const tarPath = join(dir, "sdist.tar.gz");
    writeFileSync(tarPath, Buffer.from(tar));
    spawnSync("tar", ["-xzf", tarPath, "-C", dir], { stdio: "ignore" });
    const search = spawnSync("find", [dir, "-name", "pyproject.toml"], {
      encoding: "utf8",
    });
    for (const candidate of (search.stdout ?? "")
      .split("\n")
      .filter((line) => line !== "")) {
      const toml = readTmp(candidate, "utf8");
      const command = scriptsEntryOf(toml, projectName);
      if (command) return { command, args: [] };
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entries = {};
let resolved = 0;
let first = true;
for (const agent of agents) {
  const distribution = agent?.distribution;
  let executable = null;
  try {
    if (distribution?.binary) executable = resolveBinary(agent);
    else if (distribution?.npx || distribution?.uvx) {
      if (!first) await sleep(NPM_DELAY_MS);
      first = false;
      executable = distribution.npx
        ? await resolveNpx(agent)
        : await resolveUvx(agent);
    }
  } catch (error) {
    warn(`${agent?.id ?? "?"}: resolution failed (${error.message})`);
    continue;
  }
  if (executable === null) {
    if (distribution?.binary || distribution?.npx || distribution?.uvx)
      warn(`${agent?.id ?? "?"}: no executable resolved, skipping`);
    continue;
  }
  if (
    typeof executable.command !== "string" ||
    executable.command === "" ||
    !Array.isArray(executable.args)
  ) {
    warn(`${agent?.id ?? "?"}: malformed executable entry, skipping`);
    continue;
  }
  entries[agent.id] = {
    version: agent.version,
    command: executable.command,
    args: executable.args,
  };
  resolved += 1;
}

writeFileSync(
  outFile,
  `${JSON.stringify(
    { generatedAt: new Date().toISOString(), entries },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `enrich-registry-executables: OK (${resolved}/${agents.length} resolved → ${outFile})`,
);
