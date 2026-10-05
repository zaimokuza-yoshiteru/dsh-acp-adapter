# DSH-ACP-ADAPTER

[中文](README.md)

Use ACP Agents in DSH with native sessions, tool approvals, and team collaboration.

## Install

Plugin version `0.2.0-rc.2.4` supports DSH `0.2.0-rc.2`. See [Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases) for other versions.

**Recommended:** In DSH Creator mode, send:

> Install and enable the ACP plugin: `@zaimokuza/dsh-acp-adapter@next`.

Confirm the native prompt to install; the new plugin is enabled by default. Alternatively, open **Plugins → Add plugin**, paste `@zaimokuza/dsh-acp-adapter@next`, install it, then select **Enable now**.

<details>
<summary>Other installation methods: CLI, Git, and archive</summary>

CLI: On Desktop, use its bundled `dsh` command. On Web, use `npx` to run the official DSH CLI npm package without a global install.

Before using the Desktop CLI, fully quit the app; reopen it after the command completes. To update with the CLI, rerun the same `add` command with `@zaimokuza/dsh-acp-adapter@next`; no uninstall is needed.

```bash
# Desktop
dsh plugin --profile desktop add @zaimokuza/dsh-acp-adapter@next

# Web
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add @zaimokuza/dsh-acp-adapter@next
```

Git and archive examples. In the plugin manager, paste the Git address or .tgz URL below in place of the package name:

| Source                         | Example                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git                            | `git+https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter.git#v0.2.0-rc.2.4`                                                                             |
| Prebuilt plugin archive (.tgz) | [Download 0.2.0-rc.2.4](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases/download/v0.2.0-rc.2.4/zaimokuza-dsh-acp-adapter-0.2.0-rc.2.4.tgz) |

This archive includes compiled output and matches the npm package. GitHub's automatically generated Source code ZIP/TAR.GZ files are source archives, not built plugin packages. Uncached dependencies still require network access.

</details>

**Updates:** The plugin manager does not update plugins automatically. To update through the plugin manager, uninstall the old version, then install the new version using the recommended method above. Uninstalling the plugin does not uninstall an Agent or sign out of its account.

## Connect an Agent

The plugin ships with a snapshot of the [official ACP Agent catalog](https://agentclientprotocol.com/registry), with installation and sign-in guidance and command prefill. You can also add an ACP Agent manually. Install and sign in to the Agent CLI on the computer running DSH. Open **Plugins → ACP adapter**, follow the catalog guidance to add the Agent and check its connection, then choose its model in a new session. The plugin does not install CLIs or sign in to accounts. These Agents have completed real integration checks:

| Agent                     | ACP command        | Terminal sign-in   |
| ------------------------- | ------------------ | ------------------ |
| Devin                     | `devin acp`        | `devin auth login` |
| CodeBuddy CLI (WorkBuddy) | `codebuddy --acp`  | `codebuddy`        |
| Claude                    | `claude-agent-acp` | `claude`           |
| Codex                     | `codex-acp`        | `codex login`      |
| Kimi                      | `kimi acp`         | `kimi login`       |

> CodeBuddy CLI and the WorkBuddy desktop app share account credits, with no separate subscription required. Connect DSH through the CodeBuddy CLI. See [CodeBuddy account and subscription details](https://www.codebuddy.cn/docs/ide/Account/pricing) and the [ACP CLI reference](https://www.codebuddy.cn/docs/cli/cli-reference).

For test coverage and results, see the [E2E verification record](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/main/test/e2e/README.md).

## Preview

![An Agent working in the native DSH session UI](assets/readme/acp-session.en.png)

<details>
<summary>More screenshots</summary>

![Native DSH approval card](assets/readme/acp-permission.en.png)

![Read-only subagent details](assets/readme/acp-subagent.en.png)

![ACP Diagnostics records](assets/readme/acp-diagnostics.en.png)

</details>

**Auto** automatically approves DSH native tool requests for the current session. **Ask** shows the native approval card when the Agent requests approval. The Agent controls its own tools. **Stop** stops the current turn; press Enter to queue a message, which supported Agents continue in the same Agent session. With DSH's experimental Agent Teams enabled, you can view member progress and handle approvals from the main conversation.

## Troubleshooting and feedback

| Symptom                              | First check                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Command will not start               | Check the Agent executable path and try an absolute path.                                                |
| Sign-in or authentication fails      | Sign in through the Agent CLI and check configured environment variables.                                |
| Older subagent details will not open | Follow the native recovery notice; incompatible old details remain in local history with an error shown. |
| Session requests recovery            | Follow the composer notice and **ACP Diagnostics**; do not clear local data.                             |

Export the safe summary JSON from **ACP Diagnostics**; it excludes message text, commands, paths, raw session IDs, and ACP credentials. DSH's native session-log ZIP may contain prompts, tool arguments, file paths, and attachments; inspect and redact it before sharing.

For help, open an [issue](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues) with the error reference, DSH/plugin versions, and redacted log excerpts. See the [native reuse boundaries](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/main/docs/native-reuse.en.md).
