# ACP Agent differences and contribution boundaries

[中文](agent-compatibility.md)

An ordinary ACP Agent needs no new runtime, dedicated client, or implementation class. Add its command and arguments manually in settings to use the shared ACP handshake, capability discovery, session lifecycle, tool approval, and activity projection. Catalog metadata provides installation and display information only; a new catalog entry must not automatically gain proprietary behavior.

## Minimum steps for adding a difference

1. Reproduce the behavior through the generic path first. Record the actual `initialize.agentInfo`, advertised capabilities, and requests or notifications that cause the difference. Confirm that the standard protocol cannot express the behavior.
2. Add a narrow function or immutable parameters in `src/agents/<agent>.ts`. Use one file when that is sufficient; introduce a directory when there is an independent protocol parser to organize. Adding an Agent does not require copying connection, session, or approval implementations, or declaring an empty module.
3. Compose shared discovery and connection options in `src/agents/compatibility.ts`. The tool bridge reads identities from each Agent’s parser, such as the target of a CodeBuddy `DeferExecuteTool` call. The bridge checks the current session and catalog before it permits execution.
4. Add a positive case, a negative case with a mismatched identity, and a regression on the real consuming path. Tests of the template rules do not replace connection or lifecycle tests.

CodeBuddy’s handshake name is `codebuddy-code`. Some versions omit `agentInfo`. For those versions the adapter recognizes a direct `codebuddy --acp` or `codebuddy-code --acp` launch. It also recognizes the Registry’s `npx` launch of `@tencent-ai/codebuddy-code` when the profile declares `runtime: codebuddy`. This lets the adapter discover each model’s reasoning levels.

After CodeBuddy confirms a cancellation, the next message reloads the original session. This applies to profiles with `runtime: codebuddy` and recognized direct launches. A manually configured command that identifies itself as another Agent keeps that Agent’s cancellation behavior. The shared session runtime owns cancellation and persistence.

For other examples in `src/agents/`, see Qwen for handshake-based discovery, Devin and Codex for probe parameters, Claude for notifications, and Antigravity for executable overrides.

## Keep the four identities separate

| Fact                                    | Purpose                                                                 | Must not imply                                           |
| --------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| profile id / `acp-<id>`                 | User configuration, routing, and session binding                        | CLI brand or permissions                                 |
| Explicit runtime                        | Supported compatibility behavior that must be known before launch       | Catalog wording or a command string                      |
| Handshake Agent identity + capabilities | Protocol differences and available operations on the current connection | Authentication, continued availability, or authorization |
| catalog id                              | Catalog display and creation presets                                    | The runtime of a saved configuration                     |

Only the previously supported Devin/Codex/Claude profile IDs retain the historical runtime fallback; new Agents should explicitly bind any behavior they need. Agents that use only standard capabilities remain generic. Identity matches must be exact: command substrings and display titles must not grant permissions.

## Shared owners that remain in place

Optional AI approval backends live in `src/host/approval-review/`. Devin owns its process pool and OpenCode owns its isolated text-generation process. Both use the same decision and isolation contracts. The shared permission handler can return a one-time grant after it records the assessment.

The existing runtime/host/persistence owners retain process ownership, timeout and cancellation, session continuity, fork/recovery, pending settlement, DSH tool directory generations, approval targets, and persistence boundaries. Agent modules must not directly register DSH tools, change approval policy, commit storage, rewrite historical bindings, or hold Host services.

The protocol layer manages Qwen’s active turns and heartbeats. The domain layer parses delegations from Devin and Claude. When moving either behavior, move its event producers and consumers together and retain negative cases for cancellation, disablement, late notifications, and cross-session activity.

## Removed Kimi support

The catalog no longer displays Kimi. Old `runtime: kimi` configurations and old `id: kimi` configurations without a runtime are read only as disabled markers: their configuration and history are retained, their routes are neither registered nor probed nor launched, and they do not automatically fall back to generic. Settings explains that support has been removed. Other Agent configurations remain usable, and users can explicitly delete the old configuration.

The official Registry snapshot is retained unchanged; catalog composition filters out retired entries. The persisted launch fingerprint retains the original `KIMI_CODE_HOME` serialization position and ordering to avoid changing the identity hash of every existing Agent. It grants neither access nor a launch environment override. Historical compatibility is read-only: it neither relaxes binding comparisons nor rewrites user history.

## Devin version requirement

This branch supports Devin CLI `3000.14.30821` and later. CI checks the session tool bridge with that pinned version. If you use an older CLI, upgrade to the [latest stable release](https://docs.devin.ai/cli/changelog/stable) and confirm with `devin --version`. The adapter supplies the tool bridge through standard ACP session `mcpServers`. HTTP loopback routing preserves existing proxy exclusions and adds only `127.0.0.1`.

Existing user MCP configuration and launchers are not automatically deleted. Each new session supplies its own bridge; generic stdio transport remains available for Agents without HTTP support. Devin requests use manual approval by default. The supported local CLI can use [AI approval](permission-policy.en.md#ai-approval) in plugin details.

For a large tool catalog, Devin saves the full output to a temporary file and uses its own read or search tools to inspect the needed definitions. This is normal discovery; DSH task operations still use the current session's MCP tools, with native permission policies unchanged.
