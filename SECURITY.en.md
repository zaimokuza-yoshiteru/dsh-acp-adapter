# Security policy

[中文](SECURITY.md) | [English](SECURITY.en.md)

This plugin follows an external-login-only model. Authentication is managed by the Devin,
Codex, Kimi, or Claude CLI. The plugin does not read, copy, parse, or send back tokens,
cookies, private keys, or credential-file contents. Logs and the sidecar store only opaque
path references, key names, hashes, or redacted summaries.

Do not include credentials, complete environment variables, private workspace contents,
or unredacted ACP payloads in issues, logs, or test fixtures. If you suspect a leak, do not
open a public issue. Send the maintainer a minimal reproduction, affected version, and file
path, and revoke or rotate the credential first when possible. Reports should contain only
the credential category and redacted excerpts.

The security boundary includes the host structure gate, process termination escalation,
approval-semantic preservation, staging reconciliation, and model-switch compare-and-set.
An external agent's own tool policy is not a DSH sandbox guarantee.
