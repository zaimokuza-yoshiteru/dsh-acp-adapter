# Non-interactive policy for external ACP permissions

[简体中文](permission-policy.md)

The adapter provides the Host-local `dsh-acp/permission-policy` extension event for policy plugins that explicitly opt in to handling complete ACP permission requests. It needs no DSH changes, adapter user setting, or built-in authorization rules. Without a provider, existing complete choices and human interaction remain unchanged.

This does not automatically migrate plugins listening to `approval/request`. That event combines machine responses with the native binary human prompt, so it cannot serve as a machine-only policy query. Its `unavailable` result also means more than absence of a rule. Providers must explicitly integrate with the new event.

## Installation and public entry

Import public types from `@zaimokuza/dsh-acp-adapter/permission-policy`. This Host ESM entry exports `AcpExternalPolicyRequest`, `AcpExternalPolicyDecision`, and `AcpPermissionFacts<T>`, including Cordis service and event declarations. Its default export is the policy service class for explicit mounting. The main adapter plugin does not install it by default; registering a listener without mounting the service does not activate machine policy. The adapter still initiates authorization calls, so providers should not call `evaluate()` to replace that flow.

A provider must depend on an adapter version containing this entry and load in the same Host through DSH's existing plugin mechanism. A deployment composition plugin mounts the service once, and multiple rule plugins share that instance. Each rule plugin declares the `acpPermissionPolicy` service dependency. Do not install a separate service for every rule plugin or expose the event remotely to clients. This is developer integration, not a new user setting.

The following pair provides complete composition and rule entries. First create `policy-rules.ts`: it demonstrates denying execution operations for the Antigravity runtime identified by the adapter and delegates other requests to later providers. This is not a built-in adapter rule.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AcpExternalPolicyRequest } from '@zaimokuza/dsh-acp-adapter/permission-policy'

export const inject = ['acpPermissionPolicy']

export function apply(ctx: Context): void {
  ctx.on('dsh-acp/permission-policy', async (request: AcpExternalPolicyRequest, next) => {
    if (request.signal?.aborted) return 'cancelled'
    if (request.profile !== 'antigravity') return next()
    if (request.params.toolCall.kind === 'execute') return 'deny-once'
    return next()
  })
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

Only these five results are valid:

| Result           | Adapter behavior                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-once`     | Selects the original ID only when there is exactly one `allow_once`. Missing or multiple once scopes retain complete human choice. Never converts to a standing grant.                                                |
| `deny-once`      | Selects the original ID of a unique `reject_once`. If rejection cannot be represented uniquely, cancels without a human fallback that could allow the operation.                                                      |
| `not-applicable` | Ends the policy chain and retains complete human choice. Call and return `next()` to defer to another provider.                                                                                                       |
| `cancelled`      | Cancels authorization without falling back to a human grant.                                                                                                                                                          |
| `failed`         | Cancels authorization and uses native feedback to state that the rule was unavailable and the operation was not authorized. Exceptions and invalid results receive this treatment without exposing exception details. |

A policy decision does not replace Sidecar persistence. The existing permission handler owns the same `asked` / `decided` audit pair and checks persistence, cancellation, and Agent identity before replying to ACP. The service adds no rule store, grant cache, or persistence owner.

## Multiple providers and lifecycle

This event uses Cordis waterfall, not an aggregate vote:

1. Providers normally run in registration order. Explicit `{ prepend: true }` puts a listener before existing listeners. Scope filtering uses the original Agent identity and its ancestors; sibling sessions do not receive one another's requests.
2. A provider without an applicable rule should `return next()`. The end of the chain returns `not-applicable`.
3. Returning a result without calling `next()` prevents later providers from running. Returning `not-applicable` also ends the chain; it does not automatically skip that provider.
4. This is ordered delegation, **not a global deny-overrides policy across plugins**. An earlier allow can prevent a later deny from being evaluated. Deployment owners must own the ordering, and providers should not rewrite a downstream decision after invoking `next()`.

Registrations belong to the provider's Cordis fiber. Removing a registration prevents new requests; the provider still owns cleanup of already accepted asynchronous work. Actual unloading of the policy service immediately cancels accepted callers and waits for started callbacks to settle. An in-process plugin that ignores cancellation and never exits cannot be safely killed; unloading continues to wait. There is no timeout that manufactures an allow or forces completion.

## Preserved routes and boundaries

- Binary permission requests keep native approval. Ordinary Antigravity interactive questions do not enter this machine policy event.
- Auto for verified DSH bridge tools keeps its existing path and actual `tools.execute` checks. This extension does not redefine Auto, Full access, bypass, or a child session's native `never` policy.
- Complete Devin permission requests retain the conservative human route. Agent metadata or mode cannot prove that enterprise-enforced Ask is eligible for an automatic response.
- The parent page only presents the original child's request. Replies, execution identity, and audit remain with that child. Cancellation, Agent replacement, and late decisions cannot authorize an invalidated request.
- Only permission requests actually sent over ACP are handled. Operations inside an Agent's private process that send no request cannot be intercepted here, and these tools do not become DSH Auto Review calls. ACP client-provided file and terminal operations retain their separate control paths.
- Without a matching rule and an online human, the request still waits. Browser connectivity cannot imply permission. This does not promise universal unattended execution or recovery of an unfinished machine policy call after a Host crash.

Providers must validate their own rules and deployment order. A test provider does not certify compatibility with the Issue author's actual plugin, every Agent, enterprise policy, or operating system. User installation instructions remain in the README; execution logs and test evidence do not belong in this public API document.
