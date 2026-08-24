# Getting started

[中文](../getting-started.md) | [English](getting-started.md)

## Requirements

- DSH `0.1.1-rc.2` or later. This project is verified against rc.2; rc.8 is not supported.
- Node.js `^22.19.0 || >=24.0.0`. Repository gates use Node 24.19.0.
- An installed ACP agent CLI that can run independently.

## Install the plugin

Install the public package:

```bash
dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
dsh web
```

For local development or pre-release verification:

```bash
pnpm pack
dsh plugin --profile web add /absolute/path/to/zaimokuza-dsh-acp-adapter-*.tgz
dsh web
```

Remove it with `dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter`. Use a test
profile for installation, removal, and verification. Do not experiment in a production
profile's state directory.

## Create your first ACP session

1. Complete login and health checks in the agent's own CLI by following the [agent guide index](agents/README.md).
2. Open DSH ACP settings and choose one of the currently supported Devin, Codex, Kimi, or Claude templates.
3. Confirm that the command is executable, protocol initialization succeeds, and health is `ready`.
4. Select the model, mode, or other config options actually exposed by the agent, then create a session.
5. Before the first prompt, confirm that the settings panel shows workspace permissions and agent mode as separate controls.

The backend is immutable after an ACP session is created. Create a new session when moving
from native DSH to ACP or between ACP runtimes. The plugin never migrates history implicitly
to another agent.

## Do not include secrets

Do not paste authentication files, tokens, cookies, environment-variable values, or full
command lines into plugin configuration, shell logs, test fixtures, or issues. A useful
problem report needs only the agent name and version, health status, and redacted error
category.
