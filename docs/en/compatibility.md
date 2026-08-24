# Compatibility

[中文](../compatibility.md) | [English](compatibility.md)

| Component | Accepted range | Verified |
| --- | --- | --- |
| DSH | `>=0.1.1-rc.2` | `0.1.1-rc.2` |
| Node.js | `^22.19.0 || >=24.0.0` | 24.19.0 |
| Platform | Determined by the host and agent CLI | macOS |
| Agent | Devin / Codex / Kimi / Claude ACP | Current descriptor version for each agent |

“Accepted range” is the package metadata constraint. It does not mean every version or
platform has passed real E2E verification. Windows has not been verified and is not a
currently verified platform; rc.8 is outside the compatibility range. Remote ACP
transports, cross-backend history handoff, a generic credential broker, and injection of
DSH tools, skills, or MCP servers are also outside the current product scope.

Known limitations: recovery reconciliation fails closed when Devin replay diverges after a
denied tool call; DSH session deletion has no sidecar deletion hook, so retention and
compaction follow the plugin's own lifecycle; complete controller fault injection requires
a public host seam. The automated matrix verifies the compensation logic but is not
presented as evidence of a real DSH rejection.
