# ACP adapter

[中文](README.md)

Use **Claude · Codex · Devin · Kimi** from the DSH session UI.

## <img src="assets/readme/icon-preview.svg" width="24" height="24" alt="" /> Preview

Screenshots show real **Devin · SWE-1.7 Medium** operations in a clean DSH instance.

Add an Agent, check its connection, and see the plugin version:

![ACP adapter settings, plugin version, and Devin connection](assets/readme/acp-settings.en.png)

Use Agent models, reasoning effort, and native tool presentation in a DSH session:

![Devin using SWE-1.7 Medium to edit a real file](assets/readme/acp-session.en.png)

ACP approvals reuse DSH's native approval card, with the full command visible before approval:

![A complete ACP command in the native DSH approval card](assets/readme/acp-permission.en.png)

View the subagent's actual findings in DSH's native read-only detail view:

![An ACP subagent in the native read-only detail view](assets/readme/acp-subagent.en.png)

ACP Diagnostics groups issues, operations, and technical records. Open a record for its recorded cause; search covers loaded records.

![ACP Diagnostics operations and record details](assets/readme/acp-diagnostics.en.png)

## <img src="assets/readme/icon-setup.svg" width="24" height="24" alt="" /> Prerequisite: install a supported DSH version

See `version` and `engines` in [package.json](package.json) for versions and runtime requirements. Read the compatible DSH version from the npm `alpha` package:

```bash
DSH_VERSION="$(npm view @zaimokuza/dsh-acp-adapter@alpha engines.dsh)"
npx "@deepseek-ai/dsh@$DSH_VERSION" web
```

Plugin development installs the locked npm dependencies:

```bash
pnpm install --frozen-lockfile
```

Regular development needs no upstream checkout. See the [E2E guide](test/e2e/README.md) for browser regression setup.

## <img src="assets/readme/icon-start.svg" width="24" height="24" alt="" /> Connect in three steps

**1. Install and sign in to your Agent.**

The agent catalog uses a snapshot of the [official ACP registry](https://agentclientprotocol.com) shipped with the plugin. It provides install guidance and configuration presets; inclusion does not mean each Agent has been verified. The common four:

| Agent | ACP command | Terminal login |
| --- | --- | --- |
| Claude | `claude-agent-acp` | `claude` |
| Codex | `codex-acp` | `codex login`¹ |
| Devin | `devin acp` | `devin auth login` |
| Kimi | `kimi acp` | `kimi login` |

¹ ChatGPT sign-in requires the separate Codex CLI.

Select an entry under Settings → "Add agent" to see install guidance. npm/Python entries prefill the installed executable, arguments, and environment. Other binary entries require installation for the Agent host platform and a manually entered command path; shared arguments and environment are still prefilled. The plugin does not download or install Agents automatically.

**2. Install the plugin.** This command installs the published npm `alpha` version.

```bash
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web add @zaimokuza/dsh-acp-adapter@alpha
```

**3. Open Settings → ACP adapter**, add an Agent from the catalog and review or complete its connection settings, check the connection, then choose an Agent model in a new session.

If the Agent needs an API key, add it explicitly under **Connection settings → Environment**; parent-process secrets are not inherited automatically. Catalog defaults apply only to new configurations; plugin updates do not overwrite saved settings.

Catalog versions are advisory and do not block sessions. After upgrading, retired version-reference fields in saved bindings are excluded from launch comparisons; changes to commands, arguments, environment, state directories, and tools still trigger recovery checks.

## <img src="assets/readme/icon-connect.svg" width="24" height="24" alt="" /> How it fits together

![DSH owns sessions and UI; the adapter passes context and normalizes activity; the Agent owns models, tools and permissions. External subagent projections are read-only, and jobs do not survive a DSH restart.](assets/readme/acp-overview.en.svg)

**Experimental Agent Teams:** Follows DSH’s Teams profiles and uses its native Team panel. Members inherit the Lead’s Agent, model and reasoning settings at creation, with fresh context only. Switching the Lead’s model affects future members; existing members retain theirs. A team uses one ACP Agent. Shared tasks use the native task board. Answer member approvals from the Lead; allow or reject all current ordinary approvals, with permission granted once only. The member icon at the top right shows status and models. Change Agent modes individually or in batches grouped by ACP profile; idle members apply changes immediately, while dormant members apply saved modes before their next run. Team coordination adds no approval prompts; ordinary permissions remain unchanged. Messages arrive at DSH step boundaries.

**Optional DSH plugin tools:** In the Agent Connection settings, enter one installed tool name per line under “DSH plugin tools”, or set `hostTools: ["tool_name"]`. Only selected tools are exposed over MCP and run through the native DSH tool pipeline. No additional tools are enabled by default. Ordinary tools retain Agent approval, and each DSH tool keeps its own execution rules. Avoid duplicating the Agent’s built-in tools, and start a new session after changing the list. This does not replace the Agent loop; see [native reuse boundaries](docs/native-reuse.md).

During execution, Enter queues a message; use the queue’s steering action to deliver it to the active task. The adapter uses negotiated atomic steering when available. Otherwise it cancels the current execution, waits for it to settle, and sends the input in the same Agent session. Kimi requires no additional SDK. Cancellation timeouts do not trigger an automatic resend; the Agent retains permission and context ownership. See [input capabilities and limitations](docs/agent-input-capabilities.en.md).

## <img src="assets/readme/icon-update.svg" width="24" height="24" alt="" /> Update or remove

Use the same `DSH_HOME` and profile as when starting DSH. You can replace `npx` with `pnpm dlx`; keep the host version pinned.

```bash
# Update
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web update @zaimokuza/dsh-acp-adapter
# Remove
npx "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web remove @zaimokuza/dsh-acp-adapter
```

**Keep local data when upgrading.** DSH migrates main sessions; the adapter does not migrate legacy subagent projections that the host rejects. Restart DSH after the current turn, then refresh the page; check the loaded version beside the settings title.

## <img src="assets/readme/icon-help.svg" width="24" height="24" alt="" /> If something goes wrong

| Symptom | First check |
| --- | --- |
| Command will not start | Verify the executable path; try its absolute path. |
| Login or authentication fails | Sign in through the Agent CLI; check its configured environment variables. |
| Older subagent details cannot open after upgrading | Follow DSH’s supported history formats. Unsupported projections are not migrated; original files and ACP records are retained. |
| Session needs recovery | Follow the composer notice and **ACP Diagnostics**. Do not clear local data. |

Still stuck? Include the error reference, plugin/DSH versions and relevant host log excerpt in an [issue](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/issues). Remove secrets before sharing logs.
