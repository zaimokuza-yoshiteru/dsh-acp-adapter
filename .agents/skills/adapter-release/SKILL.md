---
name: adapter-release
description: Prepare, publish or recover an ACP adapter release using the repository release guide, exact artifact evidence and the user's existing authorization.
---

# Release the adapter

Read [the release guide](../../../docs/releasing.md) and the current [publish workflow](../../../.github/workflows/publish.yml). They own versioning, tag creation, CI input freezing, npm publication, GitHub assets and failure recovery; do not duplicate or replace that procedure here.

Resolve the requested version and target revision, then use [adapter-validation](../adapter-validation/SKILL.md) to identify valid existing evidence and the checks invalidated by this release's actual inputs. Do not add a full local rehearsal, repeat the platform matrix or launch real Agent calls merely because a release follows. Read [AGENTS.md](../../../AGENTS.md) before any shared local build or Host operation.

Keep source validation and artifact validation distinct. A release Registry refresh can change the package even when its tag is unchanged; use the workflow's frozen snapshot and verified tarball when identifying the actual publication. A source-only cache or earlier local pack does not establish that artifact's validity. Report known real Agent failures and scoped coverage without turning a test task budget into a production restriction.

Use the user's existing authorization: a request to publish covers the release actions in the guide, and does not need another confirmation. Preparing a candidate or loading this skill alone does not authorize pushing a tag or publishing. Preserve configured branch/environment protections; add no approval layer of your own.

If a required release gate fails or publication has an unknown outcome, inspect the exact run and npm version state before taking the documented recovery path. Do not move release tags, overwrite published versions or rerun the whole publish flow to repair a later metadata job. Stop dependent mutations when the required state is unresolved and report the concrete blocker.

Verify the externally observed version, dist-tag, release URL and artifact identity before reporting completion. Separate published npm state from GitHub Release state and any unresolved test limitation.

The evidence-selection approach adapts DSH [`dsh-pre-push-checks` at `d743267`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/.agents/skills/dsh-pre-push-checks/SKILL.md); release behavior remains specific to this repository.
