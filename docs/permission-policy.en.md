# Non-interactive policy for external ACP permissions

[简体中文](permission-policy.md)

Policy plugins can handle external Agent permission requests through two Host-local events. Register the same rule on `dsh-acp/permission-policy` for rich choices and `dsh-acp/binary-permission-policy` for requests representable by the native binary card. Each request visits exactly one chain. Existing providers gain binary coverage when they explicitly register for it.

This does not automatically migrate plugins listening to `approval/request`. That event combines machine responses with the native binary human prompt, so it cannot serve as a machine-only policy query. Its `unavailable` result also means more than absence of a rule. Providers must explicitly integrate with the new event.

## Installation and public entry

Import public types from `@zaimokuza/dsh-acp-adapter/permission-policy`. This Host ESM entry exports `AcpExternalPolicyRequest`, `AcpExternalPolicyDecision`, and `AcpPermissionFacts<T>`, including Cordis service and event declarations. Its default export is the policy service class for explicit mounting. The main adapter plugin does not install it by default; registering a listener without mounting the service does not activate machine policy. The adapter still initiates authorization calls, so providers should not call `evaluate()` to replace that flow.

A provider must depend on an adapter version containing this entry and load in the same Host through DSH's existing plugin mechanism. A deployment composition plugin mounts the service once, and multiple rule plugins share that instance. Each rule plugin declares the `acpPermissionPolicy` service dependency. Do not install a separate service for every rule plugin or expose the event remotely to clients. This is developer integration, not a new user setting.

The following pair provides complete composition and rule entries. First create `policy-rules.ts`: it demonstrates denying execution operations for the Antigravity runtime identified by the adapter and delegates other requests to later providers. This is not a built-in adapter rule.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AcpExternalPolicyDecision, AcpExternalPolicyRequest } from '@zaimokuza/dsh-acp-adapter/permission-policy'

export const inject = ['acpPermissionPolicy']

export function apply(ctx: Context): void {
  const rule = async (request: AcpExternalPolicyRequest, next: () => Promise<AcpExternalPolicyDecision>): Promise<AcpExternalPolicyDecision> => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.profile !== 'antigravity') return next()
    if (request.params.toolCall.kind === 'execute')
      return { decision: 'deny-once', reason: 'This session only permits read operations.' }
    return next()
  }
  ctx.on('dsh-acp/permission-policy', rule)
  ctx.on('dsh-acp/binary-permission-policy', rule)
}
```

Then create `index.ts`, the composition plugin entry loaded by DSH. It mounts the shared service and the rule in order. To use multiple rule plugins, mount them here in the required order.

```ts
import type { Context } from '@deepseek-ai/cordis'
import AcpPermissionPolicy from '@zaimokuza/dsh-acp-adapter/permission-policy'
import * as rules from './policy-rules.js'

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(AcpPermissionPolicy)
  await ctx.plugin(rules)
}
```

The composition plugin's Cordis lifecycle owns the service and rule registrations. Unloading that composition cleans up both; unloading one rule plugin does not unload the shared service. The main adapter and the composition can have different owners, so unloading the main adapter does not necessarily unload the policy service. Deployment owners must manage the composition explicitly and unload it when policy is no longer needed.

A real provider should use its existing machine policy service, pass `request.signal`, and clean up its resources on cancellation. It must not open approval UI, invoke `approval.request()`, or execute the operation again. ACP parameters are facts supplied by the external Agent, not trusted proof of enterprise policy or tool ownership.

## Request and result contract

| Field       | Meaning                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`     | The actual executing DSH `Agent`, whether a child or primary session, rather than the parent displaying a card. Its live identity is preserved; the Agent itself is not cloned or frozen.                                              |
| `requestId` | The adapter permission request identity corresponding to existing asked/decided audit. Do not cache decisions by external `toolCallId` alone.                                                                                          |
| `profile`   | The adapter-resolved runtime discriminator, such as `antigravity`, `devin`, or `qwen`, with `generic` when unavailable. This is not a configured profile ID or name, and request `_meta` cannot override it.                           |
| `params`    | Deeply readonly, complete ACP request, including original option IDs, kinds, and labels. JSON facts are cloned and frozen before the first asynchronous yield. Providers cannot modify the original request or later response options. |
| `signal`    | Combined cancellation for the request and service lifetime. Providers must cooperate with cancellation; elapsed time never implies successful authorization.                                                                           |

Return one of the following strings or an object of the form `{ decision, reason?: string }`.

| Result           | Adapter behavior                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-once`     | Selects the original ID only when there is exactly one `allow_once`. Missing or multiple once scopes retain complete human choice. Never converts to a standing grant.                                                |
| `deny-once`      | Selects the original ID of a unique `reject_once`. If rejection cannot be represented uniquely, cancels without a human fallback that could allow the operation.                                                      |
| `not-applicable` | Ends the policy chain and retains complete human choice. Call and return `next()` to defer to another provider.                                                                                                       |
| `cancelled`      | Cancels authorization without falling back to a human grant.                                                                                                                                                          |
| `failed`         | Cancels authorization and uses native feedback to state that the rule was unavailable and the operation was not authorized. Exceptions and invalid results receive this treatment without exposing exception details. |

Supply a short, public reason suitable for both the user and the Agent. When a person needs to decide, the approval card shows the reason first, followed by the original operation and choices. For a policy denial or cancellation, the adapter includes the explanation once with the next independently admitted `session/prompt` for the same executing Agent and live ACP session. Existing private Agent steps only see the standard ACP permission reply. Sending the explanation does not start another model request. Stop, transport closure, and owner replacement discard pending context. Each explanation is limited to 512 characters and each connection keeps the 16 most recent. Successful grants and rule failures do not forward explanations.

A policy decision does not replace Sidecar persistence. The existing permission handler owns the same `asked` / `decided` audit pair and checks persistence, cancellation, and Agent identity before replying to ACP. The service adds no rule store, grant cache, or persistence owner.

## Same-turn command denial in Antigravity

On Apple silicon Macs, the adapter supports Google's verified `agy` 1.5.12 binary launched as `agy acp` or `agy acp --stdio`. A policy provider can register `dsh-acp/pre-tool-policy` on the same service to review the CLI's native `run_command` before execution. The adapter loads Google's `PreToolUse` hook for that process. Users can keep their workspace and existing hook files.

```ts
ctx.on('dsh-acp/pre-tool-policy', async (request, next) => {
  if (request.params.toolCall.kind === 'execute')
    return { decision: 'deny-once', reason: 'This workspace only permits read operations.' }
  return next()
})
```

The event supplies the executing Agent, the ACP session and tool call, and a cancellation signal. The public types are `AcpPreToolPolicyRequest` and `AcpPreToolPolicyDecision`. A rule can return a one-time denial with a public reason, call `next()`, or return `not-applicable` to delegate to the CLI. A denial gets its own `permission` audit entry with `phase: 'pre-tool'` and the real tool call ID. Antigravity receives the reason in the same turn. On delegation, the CLI continues with its own rules and presents its original choices if it requests approval. Existing policy providers can add the new event independently of their ACP approval handlers.

## Multiple providers and lifecycle

This event uses Cordis waterfall, not an aggregate vote:

1. Providers normally run in registration order. Explicit `{ prepend: true }` puts a listener before existing listeners. Scope filtering uses the original Agent identity and its ancestors; sibling sessions do not receive one another's requests.
2. A provider without an applicable rule should `return next()`. The end of the chain returns `not-applicable` to providers. When every provider defers, an enabled OpenCode reviewer can handle eligible requests. A provider that returns `not-applicable` directly sends the request to a person.
3. Returning a result without calling `next()` prevents later providers from running. Returning `not-applicable` also ends the chain; it does not automatically skip that provider.
4. This is ordered delegation, **not a global deny-overrides policy across plugins**. An earlier allow can prevent a later deny from being evaluated. Deployment owners must own the ordering, and providers should not rewrite a downstream decision after invoking `next()`.

Registrations belong to the provider's Cordis fiber. Removing a registration prevents new requests; the provider still owns cleanup of already accepted asynchronous work. Actual unloading of the policy service immediately cancels accepted callers and waits for started callbacks to settle. An in-process plugin that ignores cancellation and never exits cannot be safely killed; unloading continues to wait. There is no timeout that manufactures an allow or forces completion.

## Preserved routes and boundaries

- Binary permission requests use native approval when no binary rule applies. Ordinary Antigravity interactive questions stay with their question owner.
- The DSH tool bridge verifies identity and current catalog membership. Matching a tool grants no permission. Execution still passes through the host’s `tools.execute` checks.
- The parent page only presents the original child's request. Replies, execution identity, and audit remain with that child. Cancellation, Agent replacement, and late decisions cannot authorize an invalidated request.
- The two ACP permission events handle requests sent by the Agent. The Antigravity pre-execution event above covers its native command tool. ACP client-provided file and terminal operations retain their separate control paths.
- Without a matching rule and an online human, the request still waits. Browser connectivity cannot imply permission. This does not promise universal unattended execution or recovery of an unfinished machine policy call after a Host crash.

Providers must validate their own rules and deployment order.

## AI approval

AI approval is off by default in plugin details and covers supported local Devin and OpenCode profiles on macOS and Linux. The plugin combines arguments, target paths and changes already supplied for the same tool call in the current turn. A separate process with no tools asks the selected model to review the task and operation. Its provider receives the redacted content, which may include file paths and changes.

When the model rates the operation “not high risk” and the audit is saved, the plugin can select the original request’s unique one-time grant. You decide if the model flags a request as high risk, details are missing, the review fails or the Agent offers no unique one-time grant. Windows and SSH execution use manual approval.

The audit masks credentials such as cookies. When you view older records, input summaries that cannot be safely redacted are hidden. The original session can still resume. Existing database records and backups retain their original contents.

### Devin

The official CLI `3000.14.30821` is supported. The default review model is `swe-2-high`. If the selected model is unavailable, you decide on the request and can choose another model in plugin details. Third-party policies do not answer Devin requests. Organization-enforced extensions or an unverifiable inventory of extensions and MCP servers in the reviewer require a person. The working session can still use its own MCP and Teams tools.

### OpenCode

Local `opencode acp` 2.3.2 supports built-in file, search and shell tools in a main session. It uses the confirmed session model by default. You can select another review model for that Agent in plugin details. OpenCode does not identify which rule produced an Ask. Leave AI approval off if your organization requires a person to answer every Ask.

Tool origin is checked when the working connection starts. A connection opened before you enabled review keeps asking you until it reconnects. An independent OpenCode process uses its tool-free text generation API. The adapter selects the original one-time grant only after checking isolation and recording the assessment. External policy decisions take precedence. You handle policy referrals, DSH bridge tool prompts, child Agent requests, interactive questions and inconclusive assessments. The session audit distinguishes the review model's assessment from the final answer.
