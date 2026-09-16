# Input capabilities and limitations

[中文](agent-input-capabilities.md)

An Agent's native steering capability may not be available through its ACP connection. Queueing, injection into an active turn, cancellation followed by continuation, and separate side questions have different execution semantics. The adapter selects delivery behavior from the connection's advertised capabilities.

## Usage and delivery strategy

During execution, Enter queues input in DSH; the queue's steering action requests a handoff. The native DSH loop claims the inbox, runs pre-step hooks, resolves request configuration, and persists input. The adapter sends only messages admitted by the next native step, without calling private inbox methods or fabricating message events.

The default is ACP cancel → wait for the old prompt and pending approvals to settle → send a new prompt in the same Agent session. Kimi, Devin, and Codex ACP builds without an atomic idle guard use this strategy. No additional Agent SDK is required. Cancellation interrupts generation but does not undo completed external actions. A cancellation timeout or uncertain delivery requires recovery, without automatic resending.

Connections advertising `_meta.steering = { supported: true, idleBehavior: "promptRequired" }` can use native injection. The adapter retains the original ACP prompt and yields the DSH output segment, then calls `_session/steering` after the next native step admits input. `injected` continues the original prompt. Only `promptRequired` confirms that input was not consumed and permits draining the old execution before ordinary prompting. Pending permissions, unanswered user questions, and model configuration changes use the default strategy.

## Agent boundaries

These are the inspected interface boundaries. Pinned sources document the basis for each decision; upgrades still require verification of capability declarations and completion semantics.

| Agent | Native capability | ACP boundary and adapter strategy |
| --- | --- | --- |
| Codex | CLI steering; App Server `turn/steer` targets an active turn using `expectedTurnId` and fails when idle. | The inspected ACP implementation can create a new turn during an idle race and return `startedNewTurn`. That execution cannot safely share the original prompt's completion response. Uses cancellation and continuation. |
| Claude Code | CLI input queues, SDK streaming input, and ACP `_session/steering` can deliver input during execution. | Uses injection when the atomic idle contract above is advertised. Concurrent `session/prompt` with `promptQueueing` creates separate ACP Turns/Promises, rather than injecting into the original ACP Turn. SDK priority `now` may interrupt generation; pending questions use the default strategy to protect their lifecycle. |
| Kimi Code | The TypeScript CLI supports TUI `Ctrl-S`, Node SDK `Session.steer()`, and Server REST/WS queues. | The inspected ACP entry point does not expose equivalent steering. Uses cancellation and continuation without introducing an SDK. |
| Devin | The CLI supports queueing during execution, interruption followed by sending, and separate side questions. | Concurrent ACP prompts have been observed to queue, but responses share completion metadata and can precede later output. They do not establish per-message completion ownership. Uses cancellation and continuation. |

Kimi's `@moonshot-ai/kimi-code-sdk` is a TypeScript/Node Agent SDK for sessions and execution, not a Moonshot model HTTP client. A future SDK or Server transport must own execution and steering in the same runtime and adapt events, permissions, attachments, and recovery. Starting another process with the same session ID cannot control an existing ACP execution.

## Output and lifecycle

Normal handoffs retain buffered output and transfer images at complete block boundaries. New tools belong to the newly admitted message; later content from existing tools keeps its original owner. One ACP prompt may produce multiple DSH assistant segments to preserve native admission hooks and message ordering. A successful continuation does not hide the earlier response's failure or length limit.

Explicit Stop, rejected admission, a provider switch, or unloading terminates suspended execution. Late output that has not entered the native stream is not fabricated into history. Appending to an already-closed native step would require an upstream finalization API.

Ordinary prompts remain mutually exclusive so one request cannot prematurely clear another's approval state. The Agent retains ownership of permissions, its model loop, compaction, and context. See the [E2E guide](../test/e2e/README.md) for verification methods.

## Official references

- Codex: [input actions](https://developers.openai.com/codex/prompting#steering-and-queuing), [App Server](https://developers.openai.com/codex/app-server#steer-an-active-turn), [ACP idle fallback](https://github.com/agentclientprotocol/codex-acp/blob/2b48e9822330fc09f3a94a81563e5c4bb779601a/src/CodexAcpServer.ts#L1243).
- Claude Code: [CLI input queue](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works), [SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [ACP prompt queue](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2025), [ACP steering](https://github.com/agentclientprotocol/claude-agent-acp/blob/c3ff3438844f5249d6a7f5c297906e2cd3d5fa7f/src/acp-agent.ts#L2133).
- Kimi Code: [keyboard shortcuts](https://moonshotai.github.io/kimi-code/en/reference/keyboard.html#during-streaming), [Node SDK](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/node-sdk/src/session.ts#L193), [Server API](https://moonshotai.github.io/kimi-code/en/reference/server-api.html#prompts), [ACP prompt](https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-adapter/src/session.ts#L797).
- Devin: [CLI changelog](https://docs.devin.ai/cli/changelog/stable), [commands](https://docs.devin.ai/cli/reference/commands).
