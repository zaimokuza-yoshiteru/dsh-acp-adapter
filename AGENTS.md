# Working on the ACP adapter

This repository adapts external ACP Agents to DSH. DSH owns native input admission, tools and presentation; each Agent owns its model loop and native tools. Read [native reuse](docs/native-reuse.md) before changing that division. The compatibility target is the exact published DSH version in `package.json`; `reference/deepseek-harness` is a source scaffold, not a replacement dependency.

Prefer official features and logic when they preserve existing capabilities without adding user configuration, operations or migration work. For affected business domains, trace both the adapter and the pinned upstream's real producer/consumer paths before refactoring; identify maintenance removed, behavior retained, and native UI conflicts. Use the [source alignment review](docs/dsh-0.2.1-optimization.md) for the current domain map and decisions. Keep necessary ACP permissions, continuity and persistence adaptations when upstream semantics differ.

Use these workflows when their scope applies:

- [adapter-validation](.agents/skills/adapter-validation/SKILL.md): select checks, reuse evidence and investigate test failures.
- [adapter-review](.agents/skills/adapter-review/SKILL.md): review implementation, Agent inputs and native UI behavior.
- [adapter-release](.agents/skills/adapter-release/SKILL.md): prepare or publish a version through the existing release process.

Run the smallest checks that cover the changed behavior. Do not repeat passing checks merely for a commit, push or tag; CI owns the exhaustive platform matrix. Record which inputs evidence covers and rerun checks invalidated by later changes. Skills guide judgment; scripts and configured CI checks enforce mechanical requirements.

In a shared local checkout, serialize builds, prepack, stale-build probes and Host/browser E2E, including work delegated to other agents. Never replace shared `lib/` or mutate a profile while a running test consumes it. Independent read-only work may run concurrently; isolated CI runners follow their workflow topology.

Keep real Agent calls within the user's authorized authentication, model and usage scope; do not infer quota use from permission to publish or rerun until green. A test's task budget is not a production limit, and its rejection alone does not establish a product defect.

Keep local test logs, isolated profiles and candidate artifacts in gitignored `.local/`; never commit credentials. Never delete user history or authentication to repair a test. Report observed passing, failing, skipped and pending results separately, with Agent/platform/scenario limits. Compare relevant inputs before reusing historical evidence for a new revision.

These workflows selectively adapt DSH's [agent workflows at `d743267`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/skills). DSH monorepo commands, organization approvals and unrelated rules are not inherited.
