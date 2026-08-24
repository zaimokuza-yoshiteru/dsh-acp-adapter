# Devin

[中文](../../agents/devin.md) | [English](devin.md)

## CLI check

The plugin runs `devin acp`. Complete login in Devin's own terminal, then check the CLI:

```bash
devin --version
devin auth login
devin auth status
devin acp --help
```

Do not copy account details from `devin auth status` into logs or issues. The plugin retains
only opaque authentication-path references and does not open credential files.

## DSH configuration

Select the built-in Devin template and confirm workspace permissions and agent mode. Devin
ACP state may require host staging directories; workspace-write sessions pass through state
directory and recovery reconciliation gates. If continuity cannot be proven after a denied
approval, recovery enters `reconciliation-required`. Roll back or create a new session
instead of forcing the old history to continue.

Devin does not guarantee that every `request_permission` includes a tool name. The approval
panel displays a redacted fallback and bounded target information; it never invents a name.
