/** Shared visible fallbacks for ACP assistant content DSH cannot render natively. */

import type * as acp from '@agentclientprotocol/sdk'
import { redactSecretText } from '../observability/redaction.ts'

export type AcpNonTextContent = Exclude<acp.ContentBlock, { readonly type: 'text' }>

function boundedContentMetadata(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  const clean = redactSecretText(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return undefined
  return clean.length > 240 ? `${clean.slice(0, 240)}…` : clean
}

function boundedContentUri(value: string | null | undefined): string | undefined {
  const uri = boundedContentMetadata(value)
  if (uri === undefined) return undefined
  const privateSuffix = uri.search(/[?#]/)
  return privateSuffix < 0 ? uri : uri.slice(0, privateSuffix)
}

function boundedEmbeddedText(value: string): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  if (clean.length === 0) return '(empty text resource)'
  return clean.length > 4_096 ? `${clean.slice(0, 4_096)}\n… [ACP text resource truncated]` : clean
}

/** Native text fallback for ACP output kinds DSH cannot render directly. */
export function nonTextContentFallback(content: AcpNonTextContent): string {
  if (content.type === 'image') {
    const mime = boundedContentMetadata(content.mimeType) ?? 'unknown type'
    const uri = boundedContentUri(content.uri)
    return `[ACP image (${mime}${uri === undefined ? '' : `; ${uri}`}) could not be previewed in this DSH session.]`
  }
  if (content.type === 'audio') {
    return `[ACP audio (${boundedContentMetadata(content.mimeType) ?? 'unknown type'}) is available, but playback is not supported in this DSH session.]`
  }
  if (content.type === 'resource_link') {
    const name = boundedContentMetadata(content.title) ?? boundedContentMetadata(content.name) ?? 'resource'
    const mime = boundedContentMetadata(content.mimeType)
    const uri = boundedContentUri(content.uri)
    return `[ACP resource: ${name}${mime === undefined ? '' : ` (${mime})`}${uri === undefined ? '' : ` — ${uri}`}. Opening this resource is not supported in this DSH session.]`
  }
  const resource = content.resource
  const mime = boundedContentMetadata(resource.mimeType)
  const uri = boundedContentUri(resource.uri)
  if ('text' in resource) {
    return `[ACP embedded text resource${mime === undefined ? '' : ` (${mime})`}${uri === undefined ? '' : ` — ${uri}`}]:\n${boundedEmbeddedText(resource.text)}\n[End ACP embedded text resource.]`
  }
  return `[ACP embedded binary resource${mime === undefined ? '' : ` (${mime})`}${uri === undefined ? '' : ` — ${uri}`} could not be previewed in this DSH session.]`
}
