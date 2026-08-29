# @zaimokuza/dsh-acp-adapter

[中文](README.md)

Use Devin, Codex, Kimi, or Claude agents from the DeepSeek Harness (DSH) session UI. Each Agent remains responsible for its own model, tools, skills, login state, and runtime.

> `feature/0.1.2-alpha` targets the unreleased DSH
> `dsh-v0.1.2-alpha.1` source tree and is not an installable npm combination.
> The commands below still document the published release on `main`; clean-install
> validation of this branch must wait for the upstream split packages to ship.

## Preview

Add Agents in the ACP panel and check that their local ACP commands are available:

![ACP settings with Codex and Devin passing the protocol check](assets/readme/acp-settings.en.png)

Use Agent models, reasoning effort, and native tools in a DSH session:

![Codex reading a file and returning the result in a DSH session](assets/readme/acp-session.en.png)

Subagent calls remain visible in the DSH message flow:

![A Codex subagent call rendered in a DSH session](assets/readme/acp-subagent.en.png)

Use Agent audit to inspect permissions, recovery, files, configuration, and session-continuity records:

![Agent audit with expanded session-continuity details](assets/readme/acp-audit.en.png)

## Prerequisite: install DSH

You need Node.js `^22.19.0 || >=24.0.0` and DSH `>=0.1.1-rc.2`:

```bash
npx @deepseek-ai/dsh web
```

## Install the plugin

Run this on the machine running DSH:

```bash
npx @deepseek-ai/dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
npx @deepseek-ai/dsh web
```

Open DSH's ACP panel, select a built-in Agent template, provide any required executable configuration, and run the health check. The model picker shows models and options returned by the ACP session.

## Install and sign in to an Agent

Install and sign in through the Agent's own CLI first, then run the check in the ACP panel. Do not paste tokens, cookies, credential files, or passwords into DSH.

### Devin

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

### Codex

`codex-acp` is the ACP executable and includes a compatible Codex runtime. To
sign in with a ChatGPT account, install the Codex CLI separately and run
`codex login`. Alternatively, provide `CODEX_API_KEY` or `OPENAI_API_KEY` before
starting DSH. The plugin does not call ACP `authenticate` on the Agent's behalf
or store these credentials.

```bash
codex-acp --version
codex-acp --help
# Only for ChatGPT sign-in when the Codex CLI is installed:
codex login
```

### Kimi

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

### Claude

```bash
claude --version
claude-agent-acp --version
claude-agent-acp --help
```

If you are not signed in, run `claude` and follow its terminal prompts. Do not enter Claude credentials in DSH.

## Native Agent Access and boundaries

ACP sessions automatically use Native Agent Access (the DSH permission identifier is `danger-full-access`). This lets the Agent use its own configuration, login state, data home, skills, and MCP definitions. The Agent's own mode governs its behavior; the plugin only presents approval requests that the Agent chooses to send through ACP and cannot constrain Agent tools that bypass that flow. Connect only local Agents you trust.

The plugin does not inject DSH MCP servers into the Agent, read private DSH configuration, or ask you to duplicate MCP JSON. MCP servers and skills already configured in the Agent continue to work. Switching to another Agent or a native model creates a new session; history is not implicitly migrated.

## Upgrade and uninstall

Upgrade an installed plugin with:

```bash
npx @deepseek-ai/dsh plugin --profile web update @zaimokuza/dsh-acp-adapter
```

### Prerelease data compatibility

ACP sidecar data is not guaranteed to remain compatible until the stable
`0.1.0` release. If an old session reports “ACP session recovery required” or
`profile-changed` after an upgrade, stop DSH, then back up and recreate the
plugin's private data:

macOS / Linux:

```bash
mv "$HOME/.dsh/dsh-acp" "$HOME/.dsh/dsh-acp.backup"
```

Windows PowerShell:

```powershell
Rename-Item "$env:USERPROFILE\.dsh\dsh-acp" "dsh-acp.backup"
```

Restart DSH and create a brand-new DSH session. This directory contains only
the plugin's ACP bindings, recovery state, audit data, option snapshots, and
model-switch transactions. It does not contain the Agent's login, skills, MCP
configuration, or data home. Existing ACP conversations remain visible in DSH,
but cannot be resumed after their bindings are removed. You do not need to
delete the whole `~/.dsh/profiles/web` directory.

Uninstall:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

## Short troubleshooting

Run the health check again in the DSH ACP panel. Confirm the Agent's `--version`, `--help`, or health command works and that the ACP executable is on the `PATH` inherited by DSH. After changing login state, sign in through the Agent CLI first, then select “Recheck.”
