/**
 * ACP profile 显式声明的 MCP 配置。
 *
 * DSH 目前没有公开且可枚举的 MCP server 配置接口，因此这些条目归 profile
 * 自己管理，并不表示适配器会自动导入 DSH 的 MCP 注册表。密钥值只用于传递给
 * 下游 Agent，不会进入诊断、审计载荷或 UI 展示的配置草稿。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'

export type AcpMcpServerConfig =
  | {
      readonly type: 'stdio'
      readonly name: string
      readonly command: string
      readonly args: readonly string[]
      readonly env: Record<string, AcpMcpValue>
    }
  | {
      readonly type: 'http' | 'sse'
      readonly name: string
      readonly url: string
      readonly headers: Record<string, AcpMcpValue>
  }

export type AcpMcpValue = string | { readonly valueFromEnv: string }

export type AcpMcpServerList = readonly AcpMcpServerConfig[]

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function stringMap(value: unknown, label: string): Record<string, AcpMcpValue> {
  if (!plain(value) || !Object.entries(value).every(([key, item]) => key.length > 0 && (typeof item === 'string' || (plain(item) && typeof item.valueFromEnv === 'string' && ENV_NAME.test(item.valueFromEnv))))) {
    throw new TypeError(`${label} must map names to literal strings or {valueFromEnv: "ENV_NAME"}`)
  }
  return { ...(value as Record<string, AcpMcpValue>) }
}

/** 校验配置并返回经过规范化、可安全复用的快照。 */
export function acpMcpServersOf(value: unknown): AcpMcpServerList {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('mcpServers must be an array')
  const seen = new Set<string>()
  return value.map((raw, index) => {
    if (!plain(raw)) throw new TypeError(`mcpServers[${index}] must be an object`)
    const type = raw['type']
    const name = raw['name']
    if ((type !== 'stdio' && type !== 'http' && type !== 'sse') || typeof name !== 'string' || name.trim() === '') {
      throw new TypeError(`mcpServers[${index}] requires type (stdio/http/sse) and a non-empty name`)
    }
    if (seen.has(name)) throw new TypeError(`mcpServers contains duplicate name "${name}"`)
    seen.add(name)
    if (type === 'stdio') {
      const command = raw['command']
      const args = raw['args'] ?? []
      if (typeof command !== 'string' || command.length === 0 || command.includes('\u0000') || !path.isAbsolute(command)) {
        throw new TypeError(`mcpServers[${index}].command must be an absolute executable path`)
      }
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
        throw new TypeError(`mcpServers[${index}].args must be an array of strings`)
      }
      const env = stringMap(raw['env'] ?? {}, `mcpServers[${index}].env`)
      for (const [key, value] of Object.entries(env)) if (SENSITIVE_NAME.test(key) && typeof value === 'string') throw new TypeError(`mcpServers[${index}].env.${key} must use {valueFromEnv: "ENV_NAME"}; literal secret values are not accepted`)
      return { type, name, command, args: [...args] as string[], env }
    }
    const url = raw['url']
    if (typeof url !== 'string' || url.length === 0) throw new TypeError(`mcpServers[${index}].url must be a URL`)
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new TypeError(`mcpServers[${index}].url must be a valid URL`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError(`mcpServers[${index}].url must use http or https`)
    if (parsed.username !== '' || parsed.password !== '') throw new TypeError(`mcpServers[${index}].url must not contain credentials; use headers instead`)
    const headers = stringMap(raw['headers'] ?? {}, `mcpServers[${index}].headers`)
    for (const [key, value] of Object.entries(headers)) if (SENSITIVE_NAME.test(key) && typeof value === 'string') throw new TypeError(`mcpServers[${index}].headers.${key} must use {valueFromEnv: "ENV_NAME"}; literal secret values are not accepted`)
    for (const [key, value] of Object.entries(headers)) if (/[\r\n]/.test(key) || (typeof value === 'string' && /[\r\n]/.test(value))) throw new TypeError(`mcpServers[${index}] headers must not contain CR/LF`)
    return { type, name, url, headers }
  })
}

/** 将已校验的 profile 配置转换为 ACP v1 session/new 与 session/load 的结构。 */
export function acpMcpSnapshot(servers: AcpMcpServerList, source: Readonly<Record<string, string | undefined>> = {}): acp.McpServer[] {
  const resolve = (value: AcpMcpValue, label: string): string => {
    if (typeof value === 'string') return value
    const resolved = source[value.valueFromEnv]
    if (resolved === undefined || resolved === '') {
      throw new TypeError(`${label} requires non-empty environment variable ${value.valueFromEnv}`)
    }
    return resolved
  }
  return servers.map((server) => {
    if (server.type === 'stdio') return {
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: resolve(value, `MCP server "${server.name}" env.${name}`) })),
    }
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value: resolve(value, `MCP server "${server.name}" header ${name}`) })),
    }
  })
}

/** 不含密钥的变更标记，用于启动指纹和探测缓存键。 */
export function acpMcpFingerprint(servers: AcpMcpServerList, source: Readonly<Record<string, string | undefined>> = {}): string {
  const canonical = servers.map((server) => server.type === 'stdio'
    ? { type: server.type, name: server.name, command: server.command, args: [...server.args], env: Object.entries(server.env).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, valueDescriptor(value, source)]) }
    : { type: server.type, name: server.name, url: server.url, headers: Object.entries(server.headers).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, valueDescriptor(value, source)]) })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function valueDescriptor(value: AcpMcpValue, source: Readonly<Record<string, string | undefined>>): unknown {
  return typeof value === 'string' ? { literalHash16: hashSecret(value) } : { valueFromEnv: value.valueFromEnv, present: source[value.valueFromEnv] !== undefined && source[value.valueFromEnv] !== '' }
}
