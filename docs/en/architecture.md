# Architecture

[中文](../architecture.md) | [English](architecture.md)

The plugin connects ACP agents to the DSH session UI while preserving the responsibility
boundary between DSH and each agent:

```text
DSH host / Cordis
      │ typed Remote + host structure gate
      ├── host/             composition, profiles, process lifecycle
      ├── protocol/v1/      ACP RPC guard, event translation, display envelopes
      ├── domain/session/   binding, resume, reconciliation, options
      ├── domain/policy/    sandbox, approvals, redaction, capability matrix
      ├── persistence/      sidecar SQLite audit and recovery support state
      └── client/data + ui  picker, model transaction, panel, tool cards
```

Dependencies flow from host and protocol through domain and persistence into the typed
remote/client glue. The copied upstream `ModelPicker` shell exists only in
`client/host-compat/model-picker/` and contains no ACP business logic. Structural drift in
the compatibility island fails closed while preserving native DSH routing.

## Lifecycle

Creation starts and initializes the agent, persists the binding, and only then permits the
first prompt. Recovery loads the session into staging and compares DSH history with the ACP
terminal state item by item. If identity and continuity cannot be proven, further prompts
are blocked.

Model switching uses a begin → agent apply → DSH select → commit transaction. A
compare-and-set conflict reports concurrent state instead of overwriting a later choice.

The DSH session log is the source of truth for user-visible history. DSH rc.2 has no
ignorable custom-event write seam, so ACP approval, binding, reconciliation, and degradation
audit records are stored in the sidecar. The sidecar is not a second conversation history.
