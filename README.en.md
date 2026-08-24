# @zaimokuza/dsh-acp-adapter

[中文](README.md) | [English](README.en.md)

A plugin for using AI agents from the
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) session UI. It
currently connects Devin, Codex, Kimi, and Claude through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/). Each agent remains
responsible for its own reasoning, tools, and runtime state, while DSH provides a unified
session UI, workspace, approval interaction, and host audit trail.

This package is a release candidate verified with DSH `0.1.1-rc.2` on macOS. Windows,
remote ACP transports, cross-backend migration within one session, and injection of DSH
tools, skills, or MCP servers are outside the verified scope.

## Installation

Install and start DSH `0.1.1-rc.2`, then add the plugin to the target profile:

```bash
dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
dsh web
```

For local tarball verification, run `pnpm pack` in this repository and pass the generated
`.tgz` absolute path to `dsh plugin --profile web add`. Verify installation and removal in
a clean profile before release. Never copy local authentication files into the plugin
directory or logs.

The minimum host version is `0.1.1-rc.2`. Peer dependencies accept that version and later
versions, but the structure compatibility gate and current verification baseline remain
rc.2; rc.8 is not supported. The Node.js range matches DSH `0.1.1-rc.2`:
`^22.19.0 || >=24.0.0`. Repository gates use Node 24.19.0 and pnpm 11.7.0.

## First session

1. Follow [Getting started](docs/en/getting-started.md) to check DSH and plugin status.
2. Log in and run health checks in the agent's own CLI, then select a built-in template in DSH ACP settings.
3. Create an ACP session and wait for the health status to become `ready` before sending a prompt.
4. See the [agent guide index](docs/en/agents/README.md) for commands, model/mode behavior, and data-directory notes.

Authentication is always managed by the agent. The plugin uses only command names,
environment-variable names, and opaque path references. It does not read, copy, or log
tokens, cookies, or secret configuration values.

## Capabilities and security boundaries

- A DSH session's execution backend is immutable after creation. Switching between native and ACP backends requires a new session.
- ACP model, mode, and reasoning controls appear only when the agent exposes the corresponding config option.
- `allowed-once` retains one-time semantics and is never mapped to `allow_always`.
- Session recovery performs staging reconciliation first. If continuity cannot be proven, recovery fails closed instead of silently attaching old DSH history to a new ACP session.
- The sidecar stores ACP binding, recovery, and approval audit data. The DSH session log remains the source of truth for user-visible history.
- An external agent's tools, skills, MCP servers, system prompt, native token accounting, and retry policy do not automatically become native DSH capabilities.

See [Architecture](docs/en/architecture.md), [Compatibility](docs/en/compatibility.md), and
[Security](SECURITY.en.md) for the detailed boundaries.

## Documentation

- [Getting started](docs/en/getting-started.md) · [中文](docs/getting-started.md)
- [Agent guides](docs/en/agents/README.md) · [中文](docs/agents/README.md): [Devin](docs/en/agents/devin.md) · [Codex](docs/en/agents/codex.md) · [Kimi](docs/en/agents/kimi.md) · [Claude](docs/en/agents/claude.md)
- [Operations and release checks](docs/en/operations.md) · [中文](docs/operations.md)
- [Architecture and lifecycle](docs/en/architecture.md) · [中文](docs/architecture.md)
- [Compatibility and known limitations](docs/en/compatibility.md) · [中文](docs/compatibility.md)
- [Troubleshooting](docs/en/troubleshooting.md) · [中文](docs/troubleshooting.md)
- [Security policy](SECURITY.en.md) · [中文](SECURITY.md)

## Local development

Contract tests require a read-only checkout of DSH `0.1.1-rc.2`. The directory is ignored
by Git:

```bash
git clone --depth 1 --branch dsh-v0.1.1-rc.2 \
  https://github.com/deepseek-ai/deepseek-harness.git reference/deepseek-harness
export DSH_UPSTREAM_CHECKOUT="$PWD/reference/deepseek-harness"
```

Run these commands sequentially:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

Tests and builds must run sequentially because they share `lib/` and `.typert/`. Before a
release, also run `pnpm check:stale-build`, `pnpm check:picker-diff`, and the install gate
without real credentials.

## License

MIT. See [LICENSE](LICENSE).
