/** Build-only Typert facade for the alpha.2 source analyzer. Never shipped. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }
  export interface TypertContext<Wire> { readonly wire: Wire }
  export interface TypertLookupMap {}
  export interface TypertContextMap {}
  export interface TypertRemoteMap {}
  export interface TypertRemoteScopeMap {}

  export interface RemoteErrorDetailsMap {
    'gateway/bad-request': { readonly issues?: readonly object[] }
    'gateway/cancelled': {}
    'gateway/internal': {}
  }
  export type RemoteErrorCode = keyof RemoteErrorDetailsMap
  export class RemoteError<Code extends RemoteErrorCode = RemoteErrorCode> extends Error {
    readonly isDSHRemoteError: true
    readonly code: Code
    readonly details: RemoteErrorDetailsMap[Code]
    constructor(code: Code, message: string, details: RemoteErrorDetailsMap[Code], options?: ErrorOptions)
  }
  export type RemoteFailure = { [Code in RemoteErrorCode]: RemoteError<Code> }[RemoteErrorCode]
  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RemoteFailure }

  export type TypertRemoteNamespace<Namespace extends string> = {
    [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}` ? Method : never]:
    TypertRemoteMap[Endpoint]
  }
  export interface TypertRemoteNamespaceMap {}
  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly unknown[]
  }

  export abstract class TypertRemoteService {
    readonly typertRemote: {
      readonly service: TypertRemoteService
      readonly serviceKey: string
      readonly namespace: string
    }
    protected constructor(ctx: unknown, serviceKey: string, options?: { readonly namespace?: string })
  }
  export function bindTypertRemote<Service extends object>(
    service: Service,
    serviceKey: string,
    options?: { readonly namespace?: string },
  ): { readonly service: Service; readonly serviceKey: string; readonly namespace: string }
  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  export function Remote(option: string | { readonly mode: 'stream' }):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
  export function RemoteScope(key: Extract<keyof TypertContextMap, string>, exportName?: string):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
