---
name: adapter-validation
description: Select and interpret checks for ACP adapter changes, or diagnose test failures, without repeating unaffected evidence or treating test task budgets as product limits.
---

# Validate the adapter

Inspect the complete change against its verified base, including staged and working-tree edits. Read the current `package.json` scripts, owning tests and affected workflow before selecting commands. Use the [E2E guide](../../../test/e2e/README.md) for scenario and fixture boundaries; source-reference checks do not replace published-host compatibility.

Choose evidence by the surface reached:

- Behavior confined to a module: its focused unit tests; add adjacent tests when a shared interface changes.
- Public types, imports or configuration: the owning typecheck and compatibility checks.
- Build, exports, workers or installation: build and the relevant built-artifact or install smoke.
- Native UI or Host integration: the owning keyless protocol/browser scenario. Inspect the selected test count; use this repository's actual argument forwarding.
- Provider behavior: existing real Agent evidence within its recorded scope, or a newly authorized bounded run. Keyless fixtures cannot certify a real Agent.

Before using a command, inspect whether it builds, cleans, starts a Host or consumes model quota. `npm pack` runs `prepack`; `check:stale-build` builds as part of its probe. Coordinate shared local resources as required by [AGENTS.md](../../../AGENTS.md).

Reuse passing evidence only after comparing its actual inputs: source tree and affected paths, lockfile, Node/package-manager versions, exact published Host, source scaffold, test/configuration inputs and, for release artifacts, the frozen Registry snapshot. Live evidence also depends on the recorded Agent CLI, model and authenticated environment; never record credential values. A new commit OID alone need not invalidate identical inputs. Conversely, an unchanged OID does not certify a changed generated file, Registry snapshot or environment. Rerun only the checks whose validity changed; do not rehearse the full suite by default.

For asynchronous failures, identify the resource owner, worker/job topology, readiness signal and completion signal. Prefer private temporary roots, atomic port allocation, explicit state/barriers and awaited cleanup. Do not prescribe retries, longer timeouts or global serialization without evidence of the awaited work and contention; shared local build serialization is an artifact constraint, not a substitute for fixture isolation.

Separate protocol/routing correctness, the test's requested behavior, its budget and external Agent behavior. A second legitimate production operation may violate a test's one-operation task. Trace requests and resulting side effects before attributing replay or adding production restrictions. Read the diagnostic encoder before interpreting byte counts or hashes. Use a controlled offline negative case when it can establish the disputed rule; preserve the limits of attribution when upstream internals were not captured.

Report exact commands, input identity, results and missing coverage. Do not describe skipped/pending checks, an eventual retry success or historical live evidence as a current pass.

Adapted from DSH [`dsh-pre-push-checks`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/skills/dsh-pre-push-checks/SKILL.md) and [`dsh-ci-test-reliability`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/skills/dsh-ci-test-reliability/SKILL.md).
