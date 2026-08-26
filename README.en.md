# @zaimokuza/dsh-acp-adapter

[中文](README.md)

Use Devin, Codex, Kimi, or Claude agents from the DeepSeek Harness (DSH) session UI.
The plugin currently connects these agents through ACP. Each agent remains responsible
for its own model, tools, skills, login state, and runtime; DSH provides the shared session
UI, process management, notifications, and audit display.

## Install DSH

You need Node.js `^22.19.0 || >=24.0.0` and DSH `>=0.1.1-rc.2`. The shortest local setup is:

```bash
npx @deepseek-ai/dsh web
```

DSH starts its Web UI at `http://127.0.0.1:3080` by default. You can also install and run DSH
from source by following the [official repository instructions](https://github.com/deepseek-ai/deepseek-harness).

## Install the plugin

On the machine running DSH, run:

```bash
npx @deepseek-ai/dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
npx @deepseek-ai/dsh web
```

Open DSH and go to ACP settings. Agent configurations are managed in the ACP panel; the model
picker shows the models and configuration options actually returned by the Agent's ACP session.
To remove the plugin:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

## Configure a supported Agent

Install and log in through the Agent's own CLI first. Then select its built-in template in DSH
ACP settings and run the health check. Never paste tokens, cookies, credential files, or passwords
into DSH.

### Devin

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

Select the Devin template in DSH ACP settings and create a session after the check is ready.

### Codex

`codex-acp` is the ACP executable and can run its own CLI login flow. If the Codex CLI is
also installed, `codex login` is supported as an alternative:

```bash
codex-acp --version
codex-acp cli login
codex-acp --help
```

Or:

```bash
codex --version
codex login
```

After completing either login flow, select the Codex template in DSH ACP settings.

### Kimi

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

Select the Kimi template and wait for its health check to complete before creating a session.

### Claude

Claude Code and its ACP adapter manage authentication through their own CLI. Complete the
Claude CLI login flow first, then check the ACP executable:

```bash
claude --version
claude-agent-acp --version
claude-agent-acp --help
```

If you are not logged in, run `claude` and follow its terminal prompts. Do not enter Claude
credentials in DSH. Then select the Claude template in DSH ACP settings. If Claude is configured
to use a compatible backend such as DeepSeek, DSH still displays the ACP Agent identity; the
plugin does not reinterpret the downstream model provider.

## Native Agent Access

ACP sessions use “Native Agent Access” by default (the DSH permission identifier is
`danger-full-access`) so the Agent can use its own configuration, login state, data home, skills,
and MCP definitions. The Agent's native mode and ACP approval flow control its file and command
permissions; DSH approval is not a security boundary against an uncooperative Agent. Use this
mode only with local Agents you trust, and configure permissions in the Agent's own CLI.

DSH workspace, session history, and the Agent's runtime state remain separate responsibility
boundaries. Switching to another Agent or a native model creates a new session; history is not
implicitly migrated to a different execution backend.

## Verify the installation

1. Select an Agent template in DSH ACP settings and run its health check.
2. Create an ACP session after the status is ready.
3. Send a simple prompt that does not modify files and confirm that messages, tool activity, and notifications
   appear in the session UI.
4. Create a new session when changing Agent; do not treat an existing session's execution
   backend as portable context.

If a check fails, run the Agent's `--version`, `--help`, or health command in its own CLI. Confirm
that the ACP executable is available in the `PATH` inherited by DSH, then run the ACP check again.

## License

MIT. See [LICENSE](LICENSE).
