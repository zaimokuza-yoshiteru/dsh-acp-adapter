# Claude

[中文](../../agents/claude.md) | [English](claude.md)

## CLI check

The plugin runs `claude-agent-acp`. Complete the official Claude CLI login flow first, then
confirm the executable without exposing account details:

```bash
claude-agent-acp --version
claude-agent-acp --help
```

The downstream CLI manages Claude authentication. The plugin neither reads the
authentication directory nor performs login or logout. For a custom executable, set
`CLAUDE_CODE_EXECUTABLE` in the DSH profile.

## Models and configuration

Only model and config options returned by the Claude session become selectable. Switching
uses the DSH model transaction and the agent's config-option write endpoint. A compare-and-
set conflict never overwrites a concurrent user choice. On restart, the plugin restores the
binding and last committed selection before allowing another prompt.
