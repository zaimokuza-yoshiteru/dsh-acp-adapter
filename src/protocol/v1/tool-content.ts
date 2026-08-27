/**
 * ACP tool-content preview and metadata codec.
 *
 * This module owns only deterministic, bounded transformations shared by the
 * translator and its tests. It does not know about turn state, session I/O,
 * or presentation sequencing.
 */
/// <reference types="node" />

import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  ACP_TOOL_CONTENT_HASH_HEX_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS,
  ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS,
} from './tool-presentation.ts'

export type AcpToolContentMetaItem = {
  type: string
  path?: string
  uri?: string
  name?: string
  title?: string
  mimeType?: string
  size?: number
  chars?: number
  hash16?: string
  operation?: 'create' | 'modify' | 'delete'
  linesAdded?: number
  linesRemoved?: number
  originalChars?: number
  truncated?: boolean
  reason?: string
  terminalId?: string
  acpType?: string
}

export type AcpToolResultMeta = {
  acpToolContent: {
    items: AcpToolContentMetaItem[]
    truncated: boolean
    originalItems: number
  }
}

/** Hashes content for audit correlation; raw content never enters the result. */
export function hash16Of(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, ACP_TOOL_CONTENT_HASH_HEX_CHARS)
}

/** Counts lines for bounded diff metadata without retaining the diff body. */
export function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

/** Returns a deterministic head/tail preview with the original length disclosed. */
export function headTailPreview(text: string): { text: string; truncated: boolean } {
  const budget = ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS + ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS
  if (text.length <= budget) return { text, truncated: false }
  const marker = `\n[…truncated: ${String(text.length)} original characters; kept the first ${String(ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS)} and last ${String(ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS)} characters…]\n`
  return {
    text: text.slice(0, ACP_TOOL_CONTENT_PREVIEW_HEAD_CHARS) + marker + text.slice(text.length - ACP_TOOL_CONTENT_PREVIEW_TAIL_CHARS),
    truncated: true,
  }
}

/** Encodes optional metadata by omission, keeping Session.append JSON-safe. */
export function toolContentMetaJson(meta: AcpToolResultMeta): JsonValue {
  const items: JsonValue[] = meta.acpToolContent.items.map((item) => {
    const out: Record<string, JsonValue> = { type: item.type }
    if (item.path !== undefined) out.path = item.path
    if (item.uri !== undefined) out.uri = item.uri
    if (item.name !== undefined) out.name = item.name
    if (item.title !== undefined) out.title = item.title
    if (item.mimeType !== undefined) out.mimeType = item.mimeType
    if (item.size !== undefined) out.size = item.size
    if (item.chars !== undefined) out.chars = item.chars
    if (item.hash16 !== undefined) out.hash16 = item.hash16
    if (item.operation !== undefined) out.operation = item.operation
    if (item.linesAdded !== undefined) out.linesAdded = item.linesAdded
    if (item.linesRemoved !== undefined) out.linesRemoved = item.linesRemoved
    if (item.originalChars !== undefined) out.originalChars = item.originalChars
    if (item.truncated !== undefined) out.truncated = item.truncated
    if (item.reason !== undefined) out.reason = item.reason
    if (item.terminalId !== undefined) out.terminalId = item.terminalId
    if (item.acpType !== undefined) out.acpType = item.acpType
    return out
  })
  return {
    acpToolContent: {
      items,
      truncated: meta.acpToolContent.truncated,
      originalItems: meta.acpToolContent.originalItems,
    },
  }
}
