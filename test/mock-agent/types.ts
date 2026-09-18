import type { ContentBlock, McpServerHttp, McpServerStdio, SessionModeState } from '@agentclientprotocol/sdk'

export type RpcId = string | number | null
// Fixtures deliberately exercise vendor extensions and malformed updates.
export type WireUpdate = { sessionUpdate: string } & Record<string, unknown>
export interface MockConfigOption {
  id: string; name: string; description?: string; category: string; type: 'select'
  currentValue: string; options: { value: string; name: string; description?: string }[]
}
export interface MockTurn {
  cancelled: boolean
  cancel(): void
  cancelWait?: () => void
  steer?: (blocks: ContentBlock[]) => void
}
export interface MockSession {
  id: string; cwd: string; modes: SessionModeState | null
  configOptions: MockConfigOption[] | null; turn: MockTurn | null; closed: boolean
  mcpServers?: ((McpServerHttp & { type: 'http' }) | (McpServerStdio & { type?: 'stdio' }))[]
  recordedHistory?: WireUpdate[]
  backgroundTerminal?: string
}
export interface MockRequest {
  id: RpcId; method: string
  params?: {
    sessionId?: string; cwd?: string; prompt?: ContentBlock[]
    mcpServers?: ((McpServerHttp & { type: 'http' }) | (McpServerStdio & { type?: 'stdio' }))[]
    configId?: string; value?: string; modeId?: string
    clientCapabilities?: { _meta?: { jetbrains?: { air?: { capabilities?: unknown } } } }
  }
}
export type PromptMessage = MockRequest & { params: { prompt: ContentBlock[] } }
export interface ClientResults {
  'session/request_permission': { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled'; optionId?: never } }
  'elicitation/create': { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  'terminal/create': { terminalId: string }
  'terminal/output': { output: string; truncated: boolean; exitStatus?: { exitCode?: number; signal?: string } }
  'terminal/wait_for_exit': { exitCode?: number; signal?: string }
  'terminal/kill': Record<string, never>
  'terminal/release': Record<string, never>
}
export interface MockPeer {
  sendUpdate(sessionId: string, update: WireUpdate, cb?: (error?: Error | null) => void): void
  sendAgentRequest<M extends keyof ClientResults>(method: M, params: Record<string, unknown>): Promise<ClientResults[M]>
  respond(id: RpcId, result: unknown): void
  log(message: string): void
}
