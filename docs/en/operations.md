# Operations and release checks

[中文](../operations.md) | [English](operations.md)

## Routine diagnostics

Record the profile, agent command and version, health state, and error category. Do not
record environment-variable values or authentication files. Check DSH, the agent CLI, ACP
initialization, a temporary session, and target-workspace permissions in that order. Do not
create a session unless health is `ready`; use the UI's rollback or new-session path for an
existing unhealthy session.

## Local gates

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
pnpm check:stale-build
pnpm check:picker-diff
git diff --check
```

Run these commands sequentially. The install gate must use an isolated profile and the
tarball. Without credentials, verify only the missing-credential degradation path. Do not
read or print an existing key or send a real model prompt merely to satisfy a gate.

## Before release

Run `pnpm pack` again from the final worktree. Confirm that the tarball contains only the
runtime library, patch, license, README files, and user documentation. Complete install,
boot, and uninstall checks in a clean DSH rc.2 profile before npm or GitHub Actions release.
Never mark CI, npm publish, Windows, or agent E2E as PASS unless it actually ran.

## npm publishing

Production publishing uses GitHub Actions Trusted Publishing. The npm package is bound to
`zaimokuza-yoshiteru/dsh-acp-adapter`, workflow `publish.yml`, and environment
`npm-publish`. The workflow uses OIDC and does not read a long-lived npm token.

For a release, update the version in `package.json`, pass every gate, then create and push a
matching tag such as `v0.1.0-rc.2`. In GitHub Actions, manually run `publish npm` from that
tag. The workflow proves that HEAD, tag, and version agree, packs once, and publishes that
same tarball. Prereleases use `next`; stable releases use `latest`. After publishing, verify
the public packument, tarball, and dist-tags. A prerelease must not occupy `latest`.
