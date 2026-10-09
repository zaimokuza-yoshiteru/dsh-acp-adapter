---
name: adapter-review
description: Review ACP adapter implementation or native UI changes against current source, real entry paths and recorded behavior, including Agent prompt, tool and lifecycle boundaries.
---

# Review the adapter

Verify the live PR base and exact head before treating a cached diff or file as current. Read surrounding implementation and both sides of changed interfaces. Prioritize incorrect behavior, lifecycle, security and compatibility over style; a review does not authorize GitHub comments, merges or unrelated edits.

Use [native reuse](../../../docs/native-reuse.md) for ownership and [input capabilities](../../../docs/agent-input-capabilities.md) for ACP execution semantics. Check these where the change reaches them:

- Trace cancellation, disposal, late completion and restoration through the shipped Loader, ACP process, MCP bridge or browser entry. A directly mounted mock plugin does not certify those paths.
- Inspect the actual Agent-visible prompts, schemas, tool results and context updates. DSH skills use the current DSH loading route; they are not installed into an Agent's private skill directory and do not grant tools or permissions.
- Distinguish new Agent requests from bridge retries using identifiers and side effects. Keep uncertain remote acceptance separate from confirmed completion with pending local persistence.
- Verify assertions observe external state, events, logs, files or exits. Require a relevant negative case for a new guard; neither coverage nor an Agent's self-report establishes the behavior.
- Match new documentation and diagnostics to the owning implementation, including serialization and verification limits. Do not expand one Agent, platform or scenario result into a complete matrix claim.

For native UI changes, reuse DSH components, tokens, locale-owned text and existing interaction patterns before adding alternatives. Verify affected light/dark and window-edge states; menus must dismiss, remain inside the viewport and escape clipping. Keep transient feedback in a surface that survives the action; failed operations retain useful content. Check affected macOS/Windows chrome behavior without changing global spacing to repair one local region. Use the focused browser scenario and inspect screenshots when geometry or appearance matters; a CSS assertion alone is insufficient visual evidence.

Use [adapter-validation](../adapter-validation/SKILL.md) to select evidence rather than rerunning an exhaustive suite during review. Report each actionable finding with its location, impact and supporting observation, and state remaining uncertainty. When asked to implement, repair the owning component within the authorized scope.

Adapted from DSH [`dsh-code-review`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/.agents/skills/dsh-code-review/SKILL.md) and [`dsh-client-ui-ux`](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/.agents/skills/dsh-client-ui-ux/SKILL.md).
