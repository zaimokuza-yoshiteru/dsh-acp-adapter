# Troubleshooting

[中文](../troubleshooting.md) | [English](troubleshooting.md)

## Health is not ready

Confirm that the CLI is executable, external login is complete, and workspace permissions
allow the agent data home. Run the agent's own doctor or help command again. The plugin does
not read credentials; if authentication has expired, repair it in the agent CLI and recheck.

## Approval did not succeed

Confirm that the requested tool name and reason are bounded, redacted text and that the UI
selection is `allowed-once`. If the agent exposes only `allow_always`, the request is
cancelled. The plugin never downgrades permanent permission into a one-time label.

## Session requires reconciliation

This is fail-closed protection: DSH history and agent replay cannot be proven consistent.
Do not delete or edit the sidecar manually. Use the UI to roll back, rebind blank, or create
a new ACP session. A problem report should contain only the session ID, state, and redacted
error category.

## Model switching failed

A concurrent update appears as a conflict; the plugin does not overwrite the later choice.
If compensation fails, the error also reports whether a new session was created and whether
the default model was restored. Check DSH settings manually, then retry one switch.
