# ACP Agent differences and contribution boundaries

[中文](agent-compatibility.md)

An ordinary ACP Agent needs no new runtime, dedicated client, or implementation class. Add its command and arguments manually in settings to use the shared ACP handshake, capability discovery, session lifecycle, tool approval, and activity projection. Catalog metadata provides installation and display information only; a new catalog entry must not automatically gain proprietary behavior.

## Minimum steps for adding a difference

1. Reproduce the behavior through the generic path first. Record the actual `initialize.agentInfo`, advertised capabilities, and requests or notifications that cause the difference. Confirm that the standard protocol cannot express the behavior.
2. Add a narrow function or immutable parameters in `src/agents/<agent>.ts`. Use one file when that is sufficient; introduce a directory when there is an independent protocol parser to organize. Adding an Agent does not require copying connection, session, or approval implementations, or declaring an empty module.
3. Compose the required facts explicitly in `src/agents/compatibility.ts` for the corresponding shared owner to consume. Do not add a universal driver, arbitrary before/after hooks, or a process-wide mutable registry.
4. Add a positive case, a negative case with a mismatched identity, and a regression on the real consuming path. Tests of the template rules do not replace connection or lifecycle tests.

CodeBuddy is an example of a small module: `codebuddy.ts` enables model-specific configuration discovery based on the actual handshake name; an explicit `runtime: codebuddy` also supplies the option to refresh the session after cancellation. The shared session runtime owns cancellation settlement, replacement sessions, and persistence; the module itself is stateless. Qwen's model configuration discovery also uses handshake identity. Devin/Codex model probe parameters, Claude's notification extension and executable override, and Antigravity's override key each have an explicit file.

## Keep the four identities separate

| Fact                                    | Purpose                                                                 | Must not imply                                           |
| --------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| profile id / `acp-<id>`                 | User configuration, routing, and session binding                        | CLI brand or permissions                                 |
| Explicit runtime                        | Supported compatibility behavior that must be known before launch       | Catalog wording or a command string                      |
| Handshake Agent identity + capabilities | Protocol differences and available operations on the current connection | Authentication, continued availability, or authorization |
| catalog id                              | Catalog display and creation presets                                    | The runtime of a saved configuration                     |

Only the previously supported Devin/Codex/Claude profile IDs retain the historical runtime fallback; new Agents should explicitly bind any behavior they need. Agents that use only standard capabilities remain generic. Identity matches must be exact: command substrings and display titles must not grant permissions.

## Shared owners that remain in place

The existing runtime/host/persistence owners retain process ownership, timeout and cancellation, session continuity, fork/recovery, pending settlement, DSH tool directory generations, approval targets, and persistence boundaries. Agent modules must not directly register DSH tools, change approval policy, commit storage, rewrite historical bindings, or hold Host services.

Qwen's active turns and heartbeats and Devin/Claude delegation parsing remain with their existing protocol and domain owners. This change only consolidates small, stateless policies whose boundaries are already clear; it does not claim to move all vendor logic. Further migrations should follow each behavior's producer and consumer together, preserving negative cases for cancellation, disablement, late notifications, and cross-session activity.

## Removed Kimi support

The catalog no longer displays Kimi. Its active runtime, proprietary permission handling, reasoning aliases, delegation parsing, and test matrix have been removed. Old `runtime: kimi` configurations and old `id: kimi` configurations without a runtime are read only as disabled markers: their configuration and history are retained, their routes are neither registered nor probed nor launched, and they do not automatically fall back to generic. Settings explains that support has been removed. Other Agent configurations remain usable, and users can explicitly delete the old configuration.

The official Registry snapshot is retained unchanged; catalog composition filters out retired entries. The persisted launch fingerprint retains the original `KIMI_CODE_HOME` serialization position and ordering to avoid changing the identity hash of every existing Agent. It grants neither access nor a launch environment override. Historical compatibility is read-only: it neither relaxes binding comparisons nor rewrites user history.
