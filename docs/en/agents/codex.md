# Codex

[中文](../../agents/codex.md) | [English](codex.md)

## CLI check

The plugin runs `codex-acp`:

```bash
codex-acp --version
codex login
```

Codex manages login and authentication state. The plugin uses only an opaque `CODEX_HOME`
path reference and never reads or prints authentication-file contents. If the installed CLI
does not accept these commands, follow the current `codex-acp --help` and configure the
actual executable in DSH.

## Approvals and subtasks

Codex may request one-time permission through ACP. Selecting `allowed-once` in DSH must
still send an `allow_once` option. Codex collaboration and subagent events appear only as
bounded tool progress and terminal summaries; they are not native DSH child sessions.
