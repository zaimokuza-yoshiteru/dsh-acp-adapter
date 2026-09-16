# Input delivery during execution (2026-09-16)

Enter queues a message in DSH. The queue's steering action requests delivery during execution. DSH still owns the inbox, pre-step hooks, input rewriting, request configuration, and `user/message` persistence. The adapter delivers only the input admitted by the next native step; it does not call private inbox methods or fabricate message events.

The default is to cancel the ACP execution, wait for the prompt and pending approvals to settle, and send the new input in the same Agent session. This currently covers Kimi, Devin, and Codex ACP builds without an atomic idle guard. No additional Agent SDK is required. Cancellation interrupts generation and does not undo external actions. An uncertain result or cancellation timeout requires recovery rather than automatic resending.

Connections advertising `_meta.steering = { supported: true, idleBehavior: "promptRequired" }` use `_session/steering` after native admission. `injected` retains the original ACP prompt; `promptRequired` confirms the input was not consumed and permits ordinary prompting. The current official Claude ACP supports this contract. Pending permission or user questions and model changes use the default strategy. Capability negotiation, rather than Agent names, selects the route.

| Agent | Native capability and current ACP boundary |
| --- | --- |
| Codex | App Server `turn/steer` requires the expected active turn. Current ACP steering can instead return `startedNewTurn` when idle; that detached execution cannot safely share the original prompt's completion. The adapter therefore uses cancellation and continuation. |
| Claude Code | Streaming SDK input and ACP steering can inject into an active execution. The adapter preserves native DSH admission before injection. Older ACP builds use SDK priority `now`; pending questions use cancellation and continuation to protect their lifecycle. |
| Kimi Code | The new TypeScript CLI supports TUI `Ctrl-S`, Node SDK `Session.steer`, and Server REST/WS queues. Current ACP does not expose these. The referenced `@moonshot-ai/kimi-code-sdk` 0.19.2 package is marked private; it is an Agent SDK, not the Moonshot model HTTP client. It is not introduced as a dependency. |
| Devin | Concurrent ACP prompts have been observed to queue input, but their responses share completion metadata and can precede later output. This does not establish safe per-message delivery ownership, so the adapter uses cancellation and continuation. |

Normal handoffs retain buffered output before a replacement prompt. New tools belong to the newly admitted message, while later content from existing tools keeps its original owner. Images are handed off only at complete block boundaries. One ACP execution can produce multiple native assistant segments; this is the display cost of retaining DSH's admission hooks.

Explicit Stop, rejected admission, a switch to another provider, or unloading terminates suspended execution. Late output that has not entered the native stream is not fabricated into assistant history. Appending it to an already-closed native step would require a DSH finalization API.

The Agent continues to own permissions, its model loop, compaction, and context. Model-specific native capabilities must not be confused with their availability through ACP. Earlier probes confirmed Codex injection and Devin queueing; Claude initially failed with an expired OAuth error because the isolated test omitted the existing DeepSeek authentication environment. Explicitly forwarding that route later passed both generation and steering; an OAuth login is not required for the DeepSeek route. Those probes are separate from adapter regression results using protocol fixtures and the real Electron shell. See the [regression record](../test/e2e/REGRESSION.md) for the final verification scope.

The [detailed research record](agent-input-capabilities.md) lists installed versions, pinned official source references, observed wire behavior, and the differences between Kimi's SDK, Server, and ACP routes.

The final `0.1.6-alpha.1.4` candidate passed 749 standard tests, 134 Web fixture checks, and 22 product checks in the real Electron shell. Separate real Codex GPT-5.5, Kimi Coding, and Devin Gemini 3.8 Flash Medium tests passed both two-turn conversations and steering after generation began. Claude ACP also passed both tests through the existing DeepSeek route (`haiku` maps to `deepseek-v4-flash`). Its earlier `ACP_AUTH_REQUIRED` was caused by the test omitting `ANTHROPIC_AUTH_TOKEN` from the explicit environment, while the native subprocess filter removed the ambient token. See [release readiness](release-readiness.md) for artifacts, checksums, and the pending publication steps.
